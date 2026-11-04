import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { FileStore, FileObjectStore } from '../src/index.js';
import { lesson } from './fixtures.js';
const paths: string[] = [];
afterEach(async () => { for (const directory of paths.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() { const directory = await mkdtemp(path.join(tmpdir(), 'tokai-db-test-')); paths.push(directory); const store = new FileStore(directory); await store.initialize(); const guest = await store.createGuest(), p = await store.authenticate(guest.token); return { directory, store, p, guest }; }
describe('FileStore compatibility contract', () => {
  it('persists one-use voice tickets, atomically acquires leases and invalidates changed lessons', async () => {
    const { directory, store, p } = await setup(), value = { ...lesson(), mode: 'live' as const }; await store.create(p, value);
    const hash = createHash('sha256').update('ticket-one').digest('hex');
    await store.voiceTickets.issue(p, { hash, sessionId: value.id, expiresAt: Date.now() + 30000 });
    const reopened = new FileStore(directory); await reopened.initialize();
    const results = await Promise.allSettled([reopened.voiceTickets.consumeAndAcquire(hash), reopened.voiceTickets.consumeAndAcquire(hash)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(result => result.status === 'fulfilled')!; if (winner.status !== 'fulfilled') throw new Error('Missing winner');
    await reopened.releaseFence(`voice:${p.ownerId}`, winner.value.fence);
    await reopened.voiceTickets.issue(p, { hash, sessionId: value.id, expiresAt: Date.now() + 30000 });
    await reopened.save(p, { ...value, revision: 1, status: 'ended' });
    await reopened.save(p, { ...value, revision: 2 });
    await expect(reopened.voiceTickets.consumeAndAcquire(hash)).rejects.toMatchObject({ code: 'INVALID_TICKET' });
    await reopened.voiceTickets.issue(p, { hash, sessionId: value.id, expiresAt: Date.now() + 30000 });
    await reopened.revoke(p); await expect(reopened.voiceTickets.consumeAndAcquire(hash)).rejects.toMatchObject({ code: 'INVALID_TICKET' });
  });
  it('atomically exposes final executor failure without overwriting a superseding resource', async () => {
    const { store, p } = await setup();
    for (const id of ['source-failed', 'source-newer']) {
      await store.resources.put(p, 'source', id, { status: 'queued', revision: 0 }, { expectedRevision: -1 });
      await store.outbox.enqueue(p, { id: `job-${id}`, kind: 'source', resourceKind: 'source', resourceId: id, expectedRevision: 0 });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const jobs = await store.outbox.claim('unavailable-executor'); expect(jobs).toHaveLength(2);
      if (attempt === 2) await store.resources.put(p, 'source', 'source-newer', { status: 'ready', revision: 1 }, { expectedRevision: 0 });
      for (const job of jobs) await store.outbox.fail(job.id, 'unavailable-executor', job.fence, { code: 'EXECUTOR_UNAVAILABLE', retryAt: new Date().toISOString() });
    }
    expect(await store.outbox.get('job-source-failed')).toMatchObject({ state: 'failed', attempts: 3 });
    expect(await store.resources.get(p, 'source', 'source-failed')).toMatchObject({ revision: 1, data: { revision: 1, status: 'failed' } });
    expect(await store.resources.get(p, 'source', 'source-newer')).toMatchObject({ revision: 1, data: { status: 'ready' } });
  });
  it('persists ownership, rejects stale revisions and never resurrects deleted lessons', async () => {
    const { directory, store, p, guest } = await setup(), value = lesson(); await store.create(p, value);
    const other = await store.authenticate((await store.createGuest()).token); await expect(store.get(other, value.id)).rejects.toMatchObject({ status: 404 });
    const next = { ...value, revision: 1, title: 'Edited' }; await store.save(p, next); await expect(store.save(p, next)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const reopened = new FileStore(directory); await reopened.initialize(); expect((await reopened.get(await reopened.authenticate(guest.token), value.id)).title).toBe('Edited');
    await store.delete(p, value.id); await expect(store.save(p, { ...next, revision: 2 })).rejects.toMatchObject({ status: 404 }); await expect(store.create(p, value)).rejects.toMatchObject({ status: 409 });
  });
  it('rolls back resources and a session together and deduplicates a reducer', async () => {
    const { store, p } = await setup(), value = lesson(); await store.create(p, value);
    await expect(store.locked(value.id, async () => { await store.resources.put(p, 'note', 'one', { text: 'temporary' }, { expectedRevision: -1, sessionId: value.id }); await store.save(p, { ...value, revision: 1 }); throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await store.get(p, value.id)).revision).toBe(0); await expect(store.resources.get(p, 'note', 'one')).rejects.toMatchObject({ status: 404 });
    let calls = 0; const reduce = (current: typeof value) => { calls++; return { session: { ...current, revision: current.revision + 1 }, result: 'saved', events: [{ id: 'event-1', type: 'lesson.changed' }] }; };
    const guard = { idempotencyKey: 'request-1', requestHash: 'body-1' }; expect(await store.mutate(p, value.id, guard, reduce)).toBe('saved'); expect(await store.mutate(p, value.id, guard, reduce)).toBe('saved'); expect(calls).toBe(1); expect(await store.events(p, value.id)).toHaveLength(1);
    await expect(store.mutate(p, value.id, { ...guard, requestHash: 'changed' }, reduce)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('claims a guest once and revokes old credentials', async () => {
    const { store, p, guest } = await setup(), value = lesson(); await store.create(p, value); const account = await store.createUser({ issuer: 'http://local-oidc', subject: 'one' }); await store.claimGuest(p, account.principal);
    expect((await store.get(account.principal, value.id)).id).toBe(value.id); await expect(store.authenticate(guest.token)).rejects.toMatchObject({ status: 401 }); await expect(store.claimGuest(p, account.principal)).rejects.toMatchObject({ status: 401 });
    await store.revoke(account.principal); await expect(store.authenticate(account.token)).rejects.toMatchObject({ status: 401 }); expect((await store.principalForOwner(account.principal.ownerId)).internal).toBe(true);
  });
  it('imports legacy hashes and preserves opaque board IDs and protected authorship', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tokai-db-legacy-')); paths.push(directory); await mkdir(path.join(directory, 'guests')); await mkdir(path.join(directory, 'sessions'));
    const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex'), value = lesson(); value.board.nodes.push({ id: 'old node / [A]', label: 'A', detail: '', kind: 'concept', x: 0, y: 0 });
    await writeFile(path.join(directory, 'guests', `${hash}.json`), JSON.stringify({ expiresAt: new Date(Date.now() + 86400000).toISOString() })); await writeFile(path.join(directory, 'sessions', `${value.id}.json`), JSON.stringify({ ownerHash: hash, session: value }));
    const store = new FileStore(directory); await store.initialize(); const saved = await store.get(await store.authenticate(token), value.id); expect(saved.board.nodes[0]).toMatchObject({ id: 'old node / [A]', author: 'student' });
  });
  it('bounds private files and prevents traversal', async () => {
    const { directory } = await setup(), files = new FileObjectStore(path.join(directory, 'objects'), 8); await files.put('owner/a.txt', Buffer.from('private'), 'text/plain'); expect((await files.get('owner/a.txt')).body.toString()).toBe('private'); await expect(files.get('owner/a.txt', { maxBytes: 2 })).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' }); await expect(files.put('../escape', Buffer.from('a'), 'text/plain')).rejects.toMatchObject({ code: 'INVALID_OBJECT_KEY' }); await files.delete('owner/a.txt'); await expect(files.head('owner/a.txt')).rejects.toMatchObject({ status: 404 });
  });
  it('enforces job leases at writes and revokes share lookup when its parent disappears', async () => {
    const { store, p } = await setup(), value = lesson(), hash = createHash('sha256').update('fixture-share').digest('hex'); await store.create(p, value);
    await store.resources.put(p, 'share', hash, { revoked: false, expiresAt: new Date(Date.now() + 60000).toISOString() }, { expectedRevision: -1, sessionId: value.id }); expect((await store.resolveShare(hash))?.principal.ownerId).toBe(p.ownerId);
    await store.outbox.enqueue(p, { id: 'job-one', kind: 'fixture', sessionId: value.id }); const [job] = await store.outbox.claim('worker-one'); await store.assertJob({ id: job!.id, workerId: 'worker-one', fence: job!.fence });
    await expect(store.assertJob({ id: job!.id, workerId: 'worker-other', fence: job!.fence })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
    await store.delete(p, value.id); expect(await store.resolveShare(hash)).toBeUndefined(); await expect(store.assertJob({ id: job!.id, workerId: 'worker-one', fence: job!.fence })).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
  });
});
