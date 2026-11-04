import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';
import { FileStore } from '@tokai/db';
import { createLesson } from '@tokai/tutor-core';

it('cancels HTTP tutor work after the request body arrived and rejects a late provider result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-disconnect-'));
  let started!: () => void, aborted!: () => void, release!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; }), providerAborted = new Promise<void>(resolve => { aborted = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const app = await createApp({ dataDir: directory, env: { GEMINI_API_KEY: 'isolated-test-key', GEMINI_MODEL: 'fixture-model' }, rateLimit: false,
    tutor: async input => {
      if (input.text === 'hold this request') { input.signal?.addEventListener('abort', aborted, { once: true }); started(); await held; }
      return { text: 'Fixture explanation.' };
    } });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
    const headers = { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const session = (await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: { topic: 'fractions', mode: 'live' } })).json().session;
    const controller = new AbortController();
    const pending = fetch(`${origin}/v1/sessions/${session.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'hold this request' }), signal: controller.signal }).catch(() => undefined);
    await providerStarted; controller.abort();
    await Promise.race([providerAborted, delay(1500).then(() => { throw new Error('Provider did not receive client cancellation'); })]);
    release(); await pending; await delay(30);
    const saved = (await app.inject({ url: `/v1/sessions/${session.id}`, headers })).json().session;
    expect(saved.messages).toHaveLength(session.messages.length); expect(saved.revision).toBe(session.revision);
    const next = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers, payload: { text: 'Continue after disconnect' } });
    expect(next.statusCode, next.body).toBe(200);
  } finally { release(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it('aborts background provider work when its authenticated executor request disconnects', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-job-disconnect-')), store = new FileStore(directory);
  let start!: () => void, abort!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), aborted = new Promise<void>(resolve => { abort = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const app = await createApp({ dataDir: directory, store, env: { GEMINI_API_KEY: 'isolated-test-key', GEMINI_MODEL: 'fixture-model', TOKAI_JOB_SECRET: 'isolated-job-secret' }, rateLimit: false,
    learning: { cards: async input => { input.signal?.addEventListener('abort', abort, { once: true }); start(); await held; return []; } } });
  try {
    const p = await store.authenticate((await store.createGuest()).token), now = new Date().toISOString();
    const session = createLesson({ id: randomUUID(), topic: 'fractions', mode: 'live', messageId: randomUUID(), now }); await store.create(p, session);
    const id = randomUUID(); await store.resources.put(p, 'artifact', id, { id, sessionId: session.id, kind: 'cards', status: 'queued', revision: 0, createdAt: now, updatedAt: now }, { expectedRevision: -1, sessionId: session.id });
    await store.outbox.enqueue(p, { id: randomUUID(), kind: 'artifact', sessionId: session.id, resourceKind: 'artifact', resourceId: id, expectedRevision: 0 });
    const job = (await store.outbox.claim('disconnect-worker', 1, 120000))[0]!;
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }), controller = new AbortController();
    const pending = fetch(`${origin}/internal/jobs/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tokai-job-secret': 'isolated-job-secret' }, body: JSON.stringify({ jobId: job.id, workerId: job.workerId, fence: job.fence }), signal: controller.signal }).catch(() => undefined);
    await started; controller.abort();
    await Promise.race([aborted, delay(1500).then(() => { throw new Error('Background provider did not receive executor cancellation'); })]);
    release(); await pending; await delay(30);
    expect((await store.resources.get<{ status: string }>(p, 'artifact', id)).data.status).toBe('queued');
    expect(await store.resources.list(p, 'artifact-file')).toEqual([]);
  } finally { release(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
