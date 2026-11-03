import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FileStore } from '@tokai/db';
import { getLessonPack } from '@tokai/learning';
import { LearnerPreferencesSchema, TeachingBeatSchema } from '@tokai/contracts';
import { createApp } from '../src/app.js';

let app: FastifyInstance, directory: string, store: FileStore, token: string, other: string;
const headers = () => ({ authorization: `Bearer ${token}` });
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'tokai-product-test-')); store = new FileStore(directory);
  app = await createApp({ dataDir: directory, store, env: { TOKAI_JOB_SECRET: 'isolated-test-worker-secret' }, rateLimit: false });
  token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
  other = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
});
afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
async function lesson() {
  const response = await app.inject({ method: 'POST', url: '/v1/lessons', headers: headers(), payload: { topic: 'fractions', mode: 'sample' } });
  expect(response.statusCode, response.body).toBe(201); return response.json().session;
}
async function present(sessionId: string, assessmentId: string) {
  const response = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/assessments`, headers: headers(), payload: { assessmentId } });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
it('saves preferences with compare-and-swap and isolates profiles', async () => {
  expect((await app.inject('/v1/me')).json().identity.kind).toBe('anonymous');
  const prefs = LearnerPreferencesSchema.parse({ displayName: 'Learner', language: 'spanish', timezone: 'Asia/Katmandu', retainTranscript: false, retentionDays: 7 });
  const saved = await app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: headers(), payload: { preferences: prefs, revision: -1 } }); expect(saved.statusCode, saved.body).toBe(200);
  expect((await app.inject({ url: '/v1/me', headers: headers() })).json().preferences.language).toBe('spanish');
  expect((await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${other}` } })).json().preferences.displayName).toBe('');
  expect((await app.inject({ method: 'PATCH', url: '/v1/me/preferences', headers: headers(), payload: { preferences: prefs, revision: -1 } })).statusCode).toBe(409);
  const quickStart = await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(), payload: { topic: 'fractions', mode: 'sample' } });
  expect(quickStart.statusCode, quickStart.body).toBe(201);
  expect(quickStart.json().session.settings.preferences).toMatchObject({ language: 'english', retainTranscript: false, retentionDays: 7 });
  expect(quickStart.json().session.plan.provenance).toBe('authored');
});
it('rejects custom samples and source-only lessons without ready owned sources', async () => {
  for (const payload of [{ topic: 'Quantum optics', mode: 'sample' }, { topic: 'fractions', mode: 'live', grounding: 'sources-only' }]) expect((await app.inject({ method: 'POST', url: '/v1/lessons', headers: headers(), payload })).statusCode).toBe(400);
  expect((await app.inject({ url: '/v1/sessions', headers: headers() })).json().sessions).toEqual([]);
});
it('serves all assessment kinds without private answer keys, and rejects cross-owner access', async () => {
  const session = await lesson(), learning = await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: headers() });
  expect(learning.statusCode, learning.body).toBe(200); expect(new Set(learning.json().assessments.map((a: { kind: string }) => a.kind)).size).toBe(5);
  expect(learning.json().assessments).toHaveLength(8); expect(learning.json().cards).toHaveLength(8);
  expect(learning.body).not.toContain('correctOptionIds'); expect(learning.body).not.toContain('acceptedAnswers');
  expect((await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
});
it('records assistance, deduplicates attempts and rejects changed duplicate answers', async () => {
  const session = await lesson(), def = getLessonPack('fractions')!.assessments.find(a => a.grading.type === 'numeric')!;
  if (def.grading.type !== 'numeric') throw new Error('Numeric fixture missing');
  const { presentation } = await present(session.id, def.id);
  const hint = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/assessments/${presentation.id}/hint`, headers: headers(), payload: {} }); expect(hint.statusCode, hint.body).toBe(200);
  const payload = { attemptId: randomUUID(), presentationId: presentation.id, assessmentId: def.id, assessmentVersion: def.version, answer: { kind: 'numeric', value: def.grading.expected, unit: def.grading.canonicalUnit } };
  const send = () => app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/attempts`, headers: headers(), payload });
  const first = await send(); expect(first.statusCode, first.body).toBe(200); expect(first.json().attempt.assisted).toBe(true); expect(first.json().evaluation.correctness).toBe('correct');
  const duplicate = await send(); expect(duplicate.json().evaluation.id).toBe(first.json().evaluation.id);
  const changed = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/attempts`, headers: headers(), payload: { ...payload, answer: { ...payload.answer, value: '9999' } } }); expect(changed.statusCode).toBe(409);
  const data = (await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: headers() })).json(); expect(data.attempts).toHaveLength(1); expect(data.mastery.every((m: { state: string }) => m.state !== 'demonstrated')).toBe(true);
});
it('carries revealed-answer assistance to subsequent presentations', async () => {
  const session = await lesson(), def = getLessonPack('fractions')!.assessments[0]!;
  const { presentation } = await present(session.id, def.id);
  expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/assessments/${presentation.id}/reveal`, headers: headers(), payload: {} })).statusCode).toBe(200);
  const next = await present(session.id, def.id); expect(next.presentation.assistance.some((e: { kind: string }) => e.kind === 'answer-reveal')).toBe(true);
});
it('applies a review exactly once and rejects a stale card after content correction', async () => {
  const session = await lesson(), card = (await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: headers() })).json().cards[0];
  const payload = { reviewId: randomUUID(), cardId: card.id, cardRevision: card.revision, expectedScheduleRevision: card.schedule.revision, rating: 'good' };
  const send = () => app.inject({ method: 'POST', url: `/v1/reviews/${card.id}/attempts`, headers: headers(), payload });
  const one = await send(), two = await send(); expect(one.statusCode, one.body).toBe(200); expect(two.json().receipt).toEqual(one.json().receipt);
  const edit = await app.inject({ method: 'PATCH', url: `/v1/flashcards/${card.id}`, headers: headers(), payload: { revision: card.revision, status: 'needs-correction' } }); expect(edit.statusCode, edit.body).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/v1/reviews/${card.id}/attempts`, headers: headers(), payload: { ...payload, reviewId: randomUUID() } })).statusCode).toBe(409);
});
it('validates source bytes, protects private downloads and queues ingestion once', async () => {
  const body = Buffer.from('A fraction represents equal parts of a specified whole.');
  const intent = { title: 'Fraction notes', filename: 'notes.txt', mimeType: 'text/plain', bytes: body.length, checksum: createHash('sha256').update(body).digest('hex') };
  const upload = await app.inject({ method: 'POST', url: '/v1/sources/uploads', headers: headers(), payload: intent }); expect(upload.statusCode, upload.body).toBe(200);
  const source = upload.json().source, url = `/v1/sources/${source.id}/content`;
  expect((await app.inject({ method: 'PUT', url, headers: { ...headers(), 'content-type': 'text/plain' }, payload: Buffer.from('wrong') })).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url, headers: { ...headers(), 'content-type': 'text/plain' }, payload: body })).statusCode).toBe(204);
  expect((await app.inject({ url: `/v1/sources/${source.id}/download`, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
  for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: `/v1/sources/${source.id}/complete`, headers: headers(), payload: {} })).json().source.status).toBe('queued');
  expect(await store.outbox.claim('isolated-source-worker', 5)).toHaveLength(1);
  await app.inject({ method: 'DELETE', url: `/v1/sources/${source.id}`, headers: headers() });
  expect((await app.inject({ url: `/v1/sources/${source.id}/download`, headers: headers() })).statusCode).toBe(404);
});
it('requires worker authorization and rejects a stale lease before executing jobs', async () => {
  const session = await lesson(); await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/end`, headers: headers() });
  const [job] = await store.outbox.claim('test-worker', 1);
  const payload = { jobId: job!.id, workerId: job!.workerId, fence: job!.fence + 1 };
  expect((await app.inject({ method: 'POST', url: '/internal/jobs/execute', payload })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/internal/jobs/execute', headers: { 'x-tokai-job-secret': 'isolated-test-worker-secret' }, payload })).statusCode).toBe(409);
});
it('never returns an HttpOnly account token in source upload instructions', async () => {
  const user = await store.createUser({ issuer: 'local-test', subject: 'private-cookie' });
  const body = Buffer.from('Private account reference text');
  const response = await app.inject({ method: 'POST', url: '/v1/sources/uploads', headers: { cookie: `tokai_session=${user.token}`, origin: 'http://localhost:3000' }, payload: { title: 'Private', filename: 'private.txt', mimeType: 'text/plain', bytes: body.length, checksum: createHash('sha256').update(body).digest('hex') } });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().headers).not.toHaveProperty('Authorization'); expect(response.body).not.toContain(user.token);
});
it('requires explicit per-lesson recap consent and respects privacy revision conflicts', async () => {
  const session = await lesson();
  expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/artifacts`, headers: headers(), payload: { kind: 'recap' } })).statusCode).toBe(409);
  const changed = await app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/privacy`, headers: headers(), payload: { revision: session.revision, retainRecapAudio: true } });
  expect(changed.statusCode, changed.body).toBe(200); expect(changed.json().session.settings.preferences.retainRecapAudio).toBe(true);
  expect((await app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/privacy`, headers: headers(), payload: { revision: session.revision, retainRecapAudio: false } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/artifacts`, headers: headers(), payload: { kind: 'recap' } })).statusCode).toBe(200);
});
it('withdraws learning evidence when a related card is marked incorrect', async () => {
  const session = await lesson(), def = getLessonPack('fractions')!.assessments.find(a => a.grading.type === 'numeric')!;
  if (def.grading.type !== 'numeric') throw new Error('Numeric fixture missing');
  const { presentation } = await present(session.id, def.id);
  const answer = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/attempts`, headers: headers(), payload: { attemptId: randomUUID(), presentationId: presentation.id, assessmentId: def.id, assessmentVersion: def.version, answer: { kind: 'numeric', value: def.grading.expected, unit: def.grading.canonicalUnit } } });
  expect(answer.statusCode, answer.body).toBe(200); expect(answer.json().evaluation.correctness).toBe('correct');
  const before = (await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: headers() })).json();
  const card = before.cards.find((card: { conceptIds: string[] }) => card.conceptIds.some(id => def.conceptIds.includes(id)));
  expect(card).toBeDefined();
  const correction = await app.inject({ method: 'PATCH', url: `/v1/flashcards/${card.id}`, headers: headers(), payload: { revision: card.revision, status: 'needs-correction' } });
  expect(correction.statusCode, correction.body).toBe(200);
  const after = (await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: headers() })).json();
  expect(after.attempts[0].evaluation.correctness).toBe('uncertain'); expect(after.attempts[0].evaluation.supersedesEvaluationId).toBe(answer.json().evaluation.id);
  expect(after.mastery.filter((item: { conceptId: string }) => card.conceptIds.includes(item.conceptId)).every((item: { independentSuccesses: number }) => item.independentSuccesses === 0)).toBe(true);
});
it('withdraws transcripts and old downloads synchronously without relying on a running worker', async () => {
  const session = await lesson(), p = await store.authenticate(token), text = 'Private spoken explanation retained only with consent.';
  session.messages.push({ id: 'spoken', role: 'tutor', text, createdAt: new Date().toISOString(), delivery: 'completed', playedMs: 1000 });
  session.teachingBeats = [TeachingBeatSchema.parse({ beatId: 'spoken-beat', turnId: 'spoken-turn', messageId: 'spoken', spokenText: text, displayText: text, conceptIds: ['whole'], outputEpoch: 1, status: 'completed', expectedBoardRevision: 0, playedMs: 1000 })]; session.revision++;
  await store.save(p, session);
  await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/end`, headers: headers() });
  const [job] = await store.outbox.claim('privacy-worker', 1, 120000);
  const executed = await app.inject({ method: 'POST', url: '/internal/jobs/execute', headers: { 'x-tokai-job-secret': 'isolated-test-worker-secret' }, payload: { jobId: job!.id, workerId: job!.workerId, fence: job!.fence } }); expect(executed.statusCode, executed.body).toBe(200);
  await store.outbox.complete(job!.id, job!.workerId!, job!.fence);
  const before = await app.inject({ url: `/v1/artifacts/${job!.resourceId}/download`, headers: headers() }); expect(before.statusCode).toBe(200); expect(before.body).toContain('Private spoken explanation retained only with consent');
  const saved = await store.get(p, session.id);
  const revoke = await app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/privacy`, headers: headers(), payload: { revision: saved.revision, retainTranscript: false } }); expect(revoke.statusCode, revoke.body).toBe(200);
  expect(revoke.json().session.messages).toEqual([]); expect(revoke.json().session.teachingBeats).toEqual([]);
  expect(JSON.stringify((await store.resources.get(p, 'study-pack', session.id)).data)).not.toContain(text);
  expect((await app.inject({ url: `/v1/artifacts/${job!.resourceId}/download`, headers: headers() })).statusCode).toBe(409);
});
