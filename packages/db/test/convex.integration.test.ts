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
  it('uses real private native storage and cleans deleted files', async () => { const key = `tests/${randomUUID()}.txt`; try { const metadata = await files.put(key, Buffer.from('private native file'), 'text/plain'); expect(metadata.size).toBe(19); expect((await files.get(key)).body.toString()).toBe('private native file'); await expect(files.get(key, { maxBytes: 2 })).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' }); await files.delete(key); await expect(files.head(key)).rejects.toMatchObject({ status: 404 }); } finally { await files.delete(key); } });
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
