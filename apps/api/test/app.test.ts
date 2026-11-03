import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import type { Session } from '@tokai/contracts';

describe('guest lesson API', () => {
  let app: FastifyInstance;
  let directory: string;
  let time: number;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tokai-api-test-'));
    time = Date.parse('2026-11-03T00:00:00Z');
    app = await createApp({ dataDir: directory, now: () => time, env: {}, rateLimit: false });
  });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function guest() {
    const response = await app.inject({ method: 'POST', url: '/v1/guest-sessions' });
    expect(response.statusCode).toBe(201);
    return response.json<{ token: string; expiresAt: string }>();
  }
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  async function lesson(token: string): Promise<Session> {
    const response = await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(token), payload: { topic: 'photosynthesis', mode: 'sample' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ session: Session }>().session;
  }
  it('reports actual configured capabilities and never falls back from live to sample', async () => {
    expect((await app.inject('/health/live')).json()).toEqual({ status: 'ok', providers: { tutor: false, speech: false, voice: false } });
    const { token } = await guest();
    const live = await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(token), payload: { topic: 'fractions', mode: 'live' } });
    expect(live.statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/v1/sessions', headers: headers(token) })).json().sessions).toEqual([]);
  });
  it('requires authentication, isolates every session action and does not persist raw tokens', async () => {
    expect((await app.inject('/v1/sessions')).statusCode).toBe(401);
    const a = await guest(); const b = await guest(); const session = await lesson(a.token);
    for (const request of [
      { method: 'GET' as const, url: `/v1/sessions/${session.id}` },
      { method: 'POST' as const, url: `/v1/sessions/${session.id}/messages`, payload: { text: 'Hello' } },
      { method: 'PATCH' as const, url: `/v1/sessions/${session.id}/board`, payload: { revision: 0, board: session.board } },
      { method: 'POST' as const, url: `/v1/sessions/${session.id}/end` },
      { method: 'POST' as const, url: `/v1/sessions/${session.id}/speech`, payload: { messageId: session.messages[0]!.id } },
      { method: 'DELETE' as const, url: `/v1/sessions/${session.id}` }
    ]) expect((await app.inject({ ...request, headers: headers(b.token) })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/sessions', headers: headers(b.token) })).json().sessions).toEqual([]);
    const persisted = await readFile(path.join(directory, 'database.json'), 'utf8');
    expect(persisted).not.toContain(a.token); expect(persisted).not.toContain(b.token);
  });
  it('expires guest access after seven days', async () => {
    const { token, expiresAt } = await guest(); await lesson(token);
    time = Date.parse(expiresAt);
    const result = await app.inject({ url: '/v1/sessions', headers: headers(token) });
    expect(result.statusCode).toBe(401); expect(result.json().code).toBe('TOKEN_EXPIRED');
  });
  it('rejects invalid input and invalid selection without changing the session', async () => {
    const { token } = await guest(); const session = await lesson(token);
    const bad = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(token), payload: { text: ' ' } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(token), payload: { text: 'Explain', selectedNodeId: 'missing' } });
    expect(missing.statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers(token) })).json().session.revision).toBe(0);
  });
  it('grounds sample selections, serializes mutations and rejects stale board revisions', async () => {
    const { token } = await guest(); const session = await lesson(token);
    const message = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(token), payload: { text: 'What is this?', selectedNodeId: 'chloroplast' } });
    expect(message.json().session.messages.at(-1).text).toContain('thylakoid');
    const patch = { method: 'PATCH' as const, url: `/v1/sessions/${session.id}/board`, headers: headers(token), payload: { revision: 1, board: session.board } };
    const responses = await Promise.all([app.inject(patch), app.inject(patch)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const result = await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers(token) });
    expect(result.json().session.revision).toBe(2);
  });
  it('ends idempotently, preserves a study summary and deletes without resurrection', async () => {
    const { token } = await guest(); const session = await lesson(token);
    const first = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/end`, headers: headers(token) });
    const second = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/end`, headers: headers(token) });
    expect(first.json().session.revision).toBe(second.json().session.revision);
    expect(first.json().session.summary).toContain('Lesson reference');
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(token), payload: { text: 'Hello' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/v1/sessions/${session.id}`, headers: headers(token) })).statusCode).toBe(204);
    expect((await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers(token) })).statusCode).toBe(404);
  });
  it('loads saved sessions after restarting the application', async () => {
    const { token } = await guest(); const session = await lesson(token);
    await app.close();
    app = await createApp({ dataDir: directory, now: () => time, env: {}, rateLimit: false });
    const restored = await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers(token) });
    expect(restored.statusCode).toBe(200); expect(restored.json().session).toEqual(session);
  });
});
