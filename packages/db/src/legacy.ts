import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSession, boundedJson } from './validation.js';
import type { ConvexTransport } from './transport.js';
type Batch = { owner: any; auth: any[]; sessions: any[]; resources: any[] };
export type LegacyImport = { directory: string; files: string[]; batches: { digest: string; batch: Batch }[]; counts: { owners: number; authSessions: number; sessions: number; resources: number; expiredGuests: number } };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export async function prepareLegacyImport(directory: string): Promise<LegacyImport> {
  directory = path.resolve(directory); const files: string[] = [];
  const read = async (filename: string) => { files.push(filename); return JSON.parse(await readFile(filename, 'utf8')); };
  const database = await read(path.join(directory, 'database.json')).catch(error => { if (!absent(error)) throw error; files.pop(); return undefined; });
  const batches: Batch[] = [];
  if (database) {
    if (database.version !== 1 || !Array.isArray(database.owners) || !Array.isArray(database.auth) || !Array.isArray(database.sessions)) throw new Error('Invalid compatibility database; nothing was imported.');
    if ((database.events?.length ?? 0) || (database.jobs?.length ?? 0) || (database.chunks?.length ?? 0) || (database.receipts?.length ?? 0)) throw new Error('This compatibility database contains Phase5 jobs/evidence. Use a full migration instead of the Phase1–4 importer.');
    for (const owner of database.owners) {
      batches.push({ owner: { id: owner.id, kind: owner.kind, ...(owner.issuer ? { issuer: owner.issuer, subject: owner.subject } : {}), ...(owner.expiresAt ? { expiresAt: Date.parse(owner.expiresAt) } : {}), ...(owner.deletedAt ? { deletedAt: Date.parse(owner.deletedAt) } : {}) },
        auth: database.auth.filter((auth: any) => auth.ownerId === owner.id).map((auth: any) => ({ id: auth.id, ownerId: owner.id, tokenHash: auth.tokenHash, expiresAt: Date.parse(auth.expiresAt), ...(auth.revoked ? { revokedAt: 1 } : {}) })),
        sessions: database.sessions.filter((record: any) => record.ownerId === owner.id).map((record: any) => { const snapshot = normalizeSession(record.session); return { id: snapshot.id, ownerId: owner.id, revision: snapshot.revision, updatedAt: snapshot.updatedAt, snapshot, ...(record.deleted ? { deletedAt: 1 } : {}) }; }),
        resources: (database.resources ?? []).filter((resource: any) => resource.ownerId === owner.id).map(({ deleted, ...resource }: any) => ({ ...resource, ...(deleted ? { deletedAt: 1 } : {}) })) });
    }
  } else {
    const names = async (dir: string) => readdir(dir).catch(error => { if (absent(error)) return []; throw error; });
    for (const filename of (await names(path.join(directory, 'guests'))).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue; const hash = filename.slice(0, -5), record = await read(path.join(directory, 'guests', filename));
      const expiresAt = Date.parse(record.expiresAt); if (!Number.isFinite(expiresAt)) throw new Error('Invalid legacy credential expiry; nothing was imported.');
      batches.push({ owner: { id: hash, kind: 'guest', expiresAt }, auth: [{ id: hash, ownerId: hash, tokenHash: hash, expiresAt }], sessions: [], resources: [] });
    }
    for (const filename of (await names(path.join(directory, 'sessions'))).sort()) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(filename)) continue; const record = await read(path.join(directory, 'sessions', filename)), batch = batches.find(batch => batch.owner.id === record.ownerHash);
      if (!batch) throw new Error('A legacy lesson has no matching guest owner; nothing was imported.');
      const snapshot = normalizeSession(record.session); if (snapshot.id + '.json' !== filename) throw new Error('A legacy lesson ID does not match its filename; nothing was imported.');
      batch.sessions.push({ id: snapshot.id, ownerId: batch.owner.id, revision: snapshot.revision, updatedAt: snapshot.updatedAt, snapshot });
    }
  }
  for (const batch of batches) {
    if (!batch.owner.id || !['guest', 'user'].includes(batch.owner.kind) || batch.owner.expiresAt !== undefined && !Number.isFinite(batch.owner.expiresAt) || batch.auth.some(auth => !/^[a-f0-9]{64}$/.test(auth.tokenHash) || !Number.isFinite(auth.expiresAt))) throw new Error('Invalid legacy identity record; nothing was imported.');
    for (const item of batch.sessions) boundedJson(item.snapshot, 850000); for (const item of batch.resources) boundedJson(item.data, 850000);
  }
  return { directory, files, batches: batches.map(batch => ({ batch, digest: createHash('sha256').update(JSON.stringify(batch)).digest('hex') })), counts: { owners: batches.length, authSessions: batches.reduce((sum, batch) => sum + batch.auth.length, 0), sessions: batches.reduce((sum, batch) => sum + batch.sessions.length, 0), resources: batches.reduce((sum, batch) => sum + batch.resources.length, 0), expiredGuests: batches.filter(batch => batch.owner.kind === 'guest' && batch.owner.expiresAt <= Date.now()).length } };
}
export async function applyLegacyImport(plan: LegacyImport, transport: ConvexTransport): Promise<{ imported: number; skipped: number; backup: string }> {
  const root = path.resolve(plan.directory), backup = path.join(root, 'backups', `before-convex-${new Date().toISOString().replace(/[:.]/g, '-')}`); await mkdir(backup, { recursive: true });
  for (const file of plan.files) { const absolute = path.resolve(file); if (!absolute.startsWith(root + path.sep)) throw new Error('Migration file is outside the selected local data directory.'); const relative = path.relative(root, absolute), target = path.join(backup, relative); await mkdir(path.dirname(target), { recursive: true }); await copyFile(absolute, target); }
  await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ counts: plan.counts, digests: plan.batches.map(value => value.digest) }), { mode: 0o600 });
  let imported = 0, skipped = 0;
  for (const value of plan.batches) { const result = await transport.call<{ imported: number; skipped: number }>('mutation', 'store:importLegacy', value); imported += result.imported; skipped += result.skipped; }
  return { imported, skipped, backup };
}
