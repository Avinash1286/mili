import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SessionSchema, type Session } from '@tokai/contracts';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export type Principal = { hash: string; expiresAt: string };
type StoredSession = { ownerHash: string; session: Session };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class FileStore {
  private locks = new Map<string, Promise<void>>();
  constructor(public readonly directory: string, private readonly clock: () => number = Date.now) {}
  async initialize() { await mkdir(path.join(this.directory, 'guests'), { recursive: true }); await mkdir(path.join(this.directory, 'sessions'), { recursive: true }); }
  async atomicWrite(file: string, value: unknown) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); await rename(temp, file); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, next);
    await previous;
    try { return await work(); }
    finally { release(); if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  assertPrincipal(principal: Principal) {
    if (Date.parse(principal.expiresAt) <= this.clock()) throw new ApiError(401, 'TOKEN_EXPIRED', 'Your guest session expired. Start a new guest session.');
  }
  async createGuest() {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.clock() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.atomicWrite(path.join(this.directory, 'guests', `${tokenHash(token)}.json`), { expiresAt });
    return { token, expiresAt };
  }
  async authenticate(token: string | undefined): Promise<Principal> {
    if (!token || !/^[\w-]{43}$/.test(token)) throw new ApiError(401, 'UNAUTHORIZED', 'A valid guest token is required.');
    const hash = tokenHash(token);
    let record: { expiresAt: string };
    try { record = JSON.parse(await readFile(path.join(this.directory, 'guests', `${hash}.json`), 'utf8')); }
    catch { throw new ApiError(401, 'UNAUTHORIZED', 'A valid guest token is required.'); }
    if (!Number.isFinite(Date.parse(record.expiresAt))) throw new ApiError(401, 'UNAUTHORIZED', 'A valid guest token is required.');
    const principal = { hash, expiresAt: record.expiresAt }; this.assertPrincipal(principal); return principal;
  }
  private sessionFile(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Lesson not found.');
    return path.join(this.directory, 'sessions', `${id}.json`);
  }
  async get(principal: Principal, id: string): Promise<Session> {
    this.assertPrincipal(principal);
    let record: StoredSession;
    try { record = JSON.parse(await readFile(this.sessionFile(id), 'utf8')); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(404, 'NOT_FOUND', 'Lesson not found.'); }
    if (record.ownerHash !== principal.hash) throw new ApiError(404, 'NOT_FOUND', 'Lesson not found.');
    return SessionSchema.parse(record.session);
  }
  async save(principal: Principal, session: Session) {
    this.assertPrincipal(principal);
    await this.atomicWrite(this.sessionFile(session.id), { ownerHash: principal.hash, session: SessionSchema.parse(session) });
  }
  async list(principal: Principal): Promise<Session[]> {
    this.assertPrincipal(principal);
    const result: Session[] = [];
    for (const filename of await readdir(path.join(this.directory, 'sessions'))) {
      if (!filename.endsWith('.json')) continue;
      try {
        const record: StoredSession = JSON.parse(await readFile(path.join(this.directory, 'sessions', filename), 'utf8'));
        if (record.ownerHash === principal.hash) result.push(SessionSchema.parse(record.session));
      } catch { /* Incomplete/corrupt records are never returned as another user's data. */ }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async delete(principal: Principal, id: string) { await this.get(principal, id); await unlink(this.sessionFile(id)); }
}
