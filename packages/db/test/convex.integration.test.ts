import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConvexStore, NativeObjectStore, ConvexLeaseManager, ServiceTransport, prepareLegacyImport, applyLegacyImport, type Principal } from '../src/index.js';
import { lesson } from './fixtures.js';
const enabled = process.env.TOKAI_TEST_CONVEX === '1';
describe.skipIf(!enabled)('actual local Convex integration', () => {
  let store: ConvexStore, otherStore: ConvexStore, p: Principal, other: Principal, files: NativeObjectStore;
  beforeAll(async () => { loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url))); store = ConvexStore.fromEnv(process.env); otherStore = ConvexStore.fromEnv(process.env); await store.initialize(); p = await store.authenticate((await store.createGuest()).token); other = await store.authenticate((await store.createGuest()).token); files = NativeObjectStore.fromEnv(process.env); });
  afterAll(async () => { if (p) await store.deleteOwner(p); if (other) await store.deleteOwner(other); await store?.close(); await otherStore?.close(); });
  it('consumes shared voice tickets exactly once across API stores and acquires one owner fence', async () => {
    const value = { ...lesson(), mode: 'live' as const }, hash = createHash('sha256').update(randomUUID()).digest('hex'); await store.create(p, value);
    await store.voiceTickets.issue(p, { hash, sessionId: value.id, expiresAt: Date.now() + 30000 });
    const results = await Promise.allSettled([store.voiceTickets.consumeAndAcquire(hash), otherStore.voiceTickets.consumeAndAcquire(hash)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled')!; if (winner.status !== 'fulfilled') throw new Error('Missing winner');
    expect(await store.fenceActive(`voice:${p.ownerId}`)).toBe(true); await otherStore.releaseFence(`voice:${p.ownerId}`, winner.value.fence);
    await store.voiceTickets.issue(p, { hash, sessionId: value.id, expiresAt: Date.now() + 30000 });
    await otherStore.voiceTickets.revoke({ sessionId: value.id }); await expect(store.voiceTickets.consumeAndAcquire(hash)).rejects.toMatchObject({ code: 'INVALID_TICKET' });
    await store.delete(p, value.id);
  });
  it('persists sessions and isolates owners through the real service JWT boundary', async () => { const value = lesson(); await store.create(p, value); expect((await otherStore.get(p, value.id)).id).toBe(value.id); await expect(store.get(other, value.id)).rejects.toMatchObject({ status: 404 }); await store.save(p, { ...value, revision: 1 }); await expect(otherStore.save(p, { ...value, revision: 1 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); await store.delete(p, value.id); await expect(store.save(p, { ...value, revision: 2 })).rejects.toMatchObject({ status: 404 }); });
  it('commits a buffered resource/session transaction atomically and rejects concurrent changes', async () => {
    const value = lesson(), id = randomUUID(); await store.create(p, value);
    await expect(store.locked(value.id, async () => { const current = await store.get(p, value.id); await store.resources.put(p, 'test', id, { value: 'staged' }, { expectedRevision: -1, sessionId: value.id }); await otherStore.save(p, { ...current, revision: 1, title: 'Concurrent' }); await store.save(p, { ...current, revision: 1, title: 'Stale' }); })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(store.resources.get(p, 'test', id)).rejects.toMatchObject({ status: 404 }); expect((await store.get(p, value.id)).title).toBe('Concurrent');
    await store.locked(value.id, async () => { const current = await store.get(p, value.id); await store.resources.put(p, 'test', id, { value: 'committed' }, { expectedRevision: -1, sessionId: value.id }); await store.save(p, { ...current, revision: 2 }); }); expect((await store.resources.get<any>(p, 'test', id)).data.value).toBe('committed'); await store.delete(p, value.id); await expect(store.resources.get(p, 'test', id)).rejects.toMatchObject({ status: 404 }); await expect(store.resources.put(p, 'test', id, {}, { expectedRevision: 0 })).rejects.toMatchObject({ status: 404 });
  });
  it('keeps command receipts and pending jobs durable and enforces job identity', async () => {
    const value = lesson(), jobId = randomUUID(); await store.create(p, value); let calls = 0;
    const guard = { idempotencyKey: randomUUID(), requestHash: 'same-body' }, reduce = (current: typeof value) => { calls++; return { session: { ...current, revision: current.revision + 1 }, result: 'saved', events: [{ id: randomUUID(), type: 'lesson.saved' }], jobs: [{ id: jobId, kind: 'integration.noop', sessionId: value.id, availableAt: new Date(Date.now() + 3600000).toISOString() }] }; };
    await store.mutate(p, value.id, guard, reduce); await otherStore.mutate(p, value.id, guard, reduce); expect(calls).toBe(1); expect(await store.events(p, value.id)).toHaveLength(1); expect(await otherStore.outbox.get(jobId)).toMatchObject({ id: jobId, state: 'pending', ownerId: p.ownerId }); await expect(store.outbox.enqueue(other, { id: jobId, kind: 'integration.noop' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('filters real vector and lexical search by authorized source', async () => {
    const id = randomUUID(), otherId = randomUUID(), embedding = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    await store.resources.put(p, 'source', id, { title: 'Private source' }, { expectedRevision: -1 }); await store.resources.put(other, 'source', otherId, { title: 'Other source' }, { expectedRevision: -1 });
    await store.chunks.replace(p, id, 0, [{ id: randomUUID(), sourceId: id, revision: 0, ordinal: 0, text: 'chloroplast sunlight private evidence', page: 2, embedding }]);
    expect((await store.chunks.search(p, { sourceIds: [id], embedding }))[0]).toMatchObject({ sourceId: id, page: 2 }); expect((await store.chunks.search(p, { sourceIds: [id], text: 'chloroplast' }))[0].text).toContain('chloroplast'); await expect(store.chunks.search(other, { sourceIds: [id], embedding })).rejects.toMatchObject({ status: 404 });
  });
  it('uses real owner-attributed private storage, rejects another owner and cleans deleted files', async () => {
    const id = randomUUID(), key = `source/${id}`;
    const usage = () => store.transport.call<any>('query', 'usage:summary', { principal: p });
    const before = await usage();
    await store.resources.put(p, 'source', id, { title: 'Private native storage test' }, { expectedRevision: -1 });
    try {
      const metadata = await files.put(key, Buffer.from('private native file'), 'text/plain', { principal: p });
      expect(metadata.size).toBe(19); expect((await files.get(key, { principal: p })).body.toString()).toBe('private native file');
      expect(metadata.expiresAt).toBe(p.expiresAt);
      await expect(files.get(key, { principal: other })).rejects.toMatchObject({ status: 404 });
      await expect(files.get(key, { principal: p, maxBytes: 2 })).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' });
      const measured = await usage();
      expect(measured.storage.bytes).toBe(before.storage.bytes + 19); expect(measured.storage.objects).toBe(before.storage.objects + 1);
      expect(measured.kinds.find((entry: any) => entry.kind === 'storage').totals.storageBytesWritten).toBe((before.kinds.find((entry: any) => entry.kind === 'storage').totals.storageBytesWritten ?? 0) + 19);
      expect(measured.kinds.find((entry: any) => entry.kind === 'egress').totals.egressBytesPrepared).toBe((before.kinds.find((entry: any) => entry.kind === 'egress').totals.egressBytesPrepared ?? 0) + 19);
      await files.delete(key); await expect(files.head(key)).rejects.toMatchObject({ status: 404 });
      expect((await usage()).storage.bytes).toBe(before.storage.bytes);
    } finally { await files.delete(key); await store.resources.delete(p, 'source', id); }
  });
  it('transfers more than4.5MB privately, rejects reuse and invalidates a changed download', async () => {
    const before = await store.transport.call<any>('query', 'usage:summary', { principal: p });
    const id = randomUUID(), bytes = Buffer.alloc(6 * 1024 * 1024, 32); bytes.write('%PDF-1.7\n');
    const checksum = createHash('sha256').update(bytes).digest('hex'), data = { status: 'awaiting-upload', bytes: bytes.length, mimeType: 'application/pdf', checksum, filename: 'private.pdf' };
    await store.resources.put(p, 'source', id, data, { expectedRevision: -1 });
    try {
      await expect(files.createTransfer(other, { kind: 'source', id, operation: 'upload' })).rejects.toMatchObject({ status: 404 });
      const upload = await files.createTransfer(p, { kind: 'source', id, operation: 'upload' }), headers = { ...upload.headers, Origin: 'http://localhost:3000' };
      expect(upload.url).not.toContain('Bearer'); expect(new URL(upload.url).search).toBe('');
      const response = await fetch(upload.url, { method: 'PUT', headers, body: bytes }); expect(response.status, await response.text()).toBe(204);
      expect((await fetch(upload.url, { method: 'PUT', headers, body: bytes })).status).toBe(401);
      expect(await files.head(`source/${id}`)).toMatchObject({ size: bytes.length, checksum });
      const download = await files.createTransfer(p, { kind: 'source', id, operation: 'download' });
      expect((await fetch(download.url, { headers: { ...download.headers, Origin: 'https://outside.example' } })).status).toBe(403);
      const result = await fetch(download.url, { headers: { ...download.headers, Origin: 'http://localhost:3000' } }); expect(result.status).toBe(200); expect(Buffer.from(await result.arrayBuffer()).equals(bytes)).toBe(true);
      expect((await fetch(download.url, { headers: { ...download.headers, Origin: 'http://localhost:3000' } })).status).toBe(401);
      const stale = await files.createTransfer(p, { kind: 'source', id, operation: 'download' }); await store.resources.put(p, 'source', id, { ...data, status: 'ready' }, { expectedRevision: 0 });
      expect((await fetch(stale.url, { headers: { ...stale.headers, Origin: 'http://localhost:3000' } })).status).toBe(409);
      const measured = await store.transport.call<any>('query', 'usage:summary', { principal: p });
      expect(measured.kinds.find((entry: any) => entry.kind === 'storage').totals.storageBytesWritten).toBe((before.kinds.find((entry: any) => entry.kind === 'storage').totals.storageBytesWritten ?? 0) + bytes.length);
      expect(measured.kinds.find((entry: any) => entry.kind === 'egress').totals.egressBytesPrepared).toBe((before.kinds.find((entry: any) => entry.kind === 'egress').totals.egressBytesPrepared ?? 0) + bytes.length);
    } finally { await files.delete(`source/${id}`); await store.resources.delete(p, 'source', id); }
  }, 30000);
  it('preserves private file access and inventory through guest claim, then consistently rejects expired downloads', async () => {
    const guest = await store.authenticate((await store.createGuest()).token), { principal: account } = await store.createUser({ issuer: 'urn:tokai:file-claim-test', subject: randomUUID() });
    const id = randomUUID(), key = `source/${id}`, bytes = Buffer.from('Private claimed file.'), data = { status: 'ready', filename: 'claimed.txt', mimeType: 'text/plain', bytes: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') };
    const summary = (principal: Principal) => store.transport.call<any>('query', 'usage:summary', { principal });
    try {
      await store.resources.put(guest, 'source', id, data, { expectedRevision: -1 });
      const original = await files.put(key, bytes, 'text/plain', { principal: guest });
      expect((await summary(guest)).storage).toEqual({ bytes: bytes.length, objects: 1 });
      await store.claimGuest(guest, account);
      expect((await files.get(key, { principal: account })).body.equals(bytes)).toBe(true);
      expect((await files.head(key)).expiresAt).toBe(original.expiresAt);
      await expect(files.get(key, { principal: guest })).rejects.toMatchObject({ status: 401 });
      expect((await summary(account)).storage).toEqual({ bytes: bytes.length, objects: 1 });
      const current = await store.resources.get(account, 'source', id);
      await store.resources.put(account, 'source', id, { ...data, fileExpiresAt: new Date(Date.now() - 1000).toISOString() }, { expectedRevision: current.revision });
      await expect(files.createTransfer(account, { kind: 'source', id, operation: 'download' })).rejects.toMatchObject({ status: 410, code: 'OBJECT_EXPIRED' });
      await files.delete(key);
      await expect(files.createTransfer(account, { kind: 'source', id, operation: 'download' })).rejects.toMatchObject({ status: 410, code: 'OBJECT_EXPIRED' });
      await expect(files.createTransfer(other, { kind: 'source', id, operation: 'download' })).rejects.toMatchObject({ status: 404 });
      expect((await summary(account)).storage).toEqual({ bytes: 0, objects: 0 });
    } finally { await files.delete(key); await store.deleteOwner(account); }
  });
  it('atomically fences competing owners and rejects stale writes', async () => { const manager = new ConvexLeaseManager(ServiceTransport.fromEnv(process.env)), key = `test:${randomUUID()}`, value = lesson(); await store.create(p, value); const first = await manager.acquire(key); expect(first).toBeDefined(); expect(await manager.acquire(key)).toBeUndefined(); await manager.release(first!); const second = await manager.acquire(key); expect(second!.fence).toBeGreaterThan(first!.fence); await expect(store.save(p, { ...value, revision: 1 }, { lease: { key, fence: first!.fence } })).rejects.toMatchObject({ code: 'LEASE_LOST' }); await store.save(p, { ...value, revision: 1 }, { lease: { key, fence: second!.fence } }); await manager.release(second!); });
  it('resolves only live explicitly shared parent records', async () => { const value = lesson(), hash = createHash('sha256').update(randomUUID()).digest('hex'); await store.create(p, value); await store.resources.put(p, 'share', hash, { expiresAt: new Date(Date.now() + 60000).toISOString(), revoked: false }, { expectedRevision: -1, sessionId: value.id }); expect((await store.resolveShare(hash))?.principal.ownerId).toBe(p.ownerId); await store.resources.put(p, 'share', hash, { expiresAt: new Date(Date.now() + 60000).toISOString(), revoked: true }, { expectedRevision: 0 }); expect(await store.resolveShare(hash)).toBeUndefined(); });
  it('imports a legacy token hash idempotently and preserves guest access', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tokai-convex-import-')), token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex'), value = lesson();
    try {
      await mkdir(path.join(directory, 'guests')); await mkdir(path.join(directory, 'sessions')); await writeFile(path.join(directory, 'guests', `${hash}.json`), JSON.stringify({ expiresAt: new Date(Date.now() + 3600000).toISOString() })); await writeFile(path.join(directory, 'sessions', `${value.id}.json`), JSON.stringify({ ownerHash: hash, session: value }));
      const plan = await prepareLegacyImport(directory), transport = ServiceTransport.fromEnv(process.env); expect((await applyLegacyImport(plan, transport)).imported).toBe(1); expect((await applyLegacyImport(plan, transport)).imported).toBe(0);
      const owner = await store.authenticate(token); expect(owner.ownerId).toBe(hash); expect((await store.get(owner, value.id)).title).toBe(value.title); await store.deleteOwner(owner);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
