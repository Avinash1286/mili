import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { plainTeachingBeat } from '@milli/tutor-core';
import { getLessonPack } from '@milli/learning';
import { createApp } from '../src/app.js';

it('connects a tutor question to a real attempt and deduplicates HTTP answers before any new provider work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-tutor-http-')); let modelCalls = 0;
  const def = getLessonPack('fractions')!.assessments.find(item => item.grading.type === 'numeric')!;
  if (def.grading.type !== 'numeric') throw new Error('Missing numeric reference');
  const app = await createApp({ dataDir: directory, rateLimit: false, env: { GEMINI_API_KEY: 'isolated-fixture-key', GEMINI_MODEL: 'fixture-model' }, tutor: async input => {
    modelCalls++;
    if (input.text === 'Ask a saved question') {
      const action = { type: 'ask_question' as const, assessmentId: def.id, assessmentVersion: def.version };
      const prepared = await input.learning!.prepare(action);
      return { text: prepared.displayText, beats: [{ ...plainTeachingBeat(prepared.spokenText), displayText: prepared.displayText, learningAction: action }] };
    }
    return { text: 'Fixture explanation without a grade.' };
  } });
  try {
    const token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token, headers = { authorization: `Bearer ${token}` };
    const session = (await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: { topic: 'fractions', mode: 'live' } })).json().session;
    const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers, payload });
    const question = await send({ text: 'Ask a saved question', requestId: randomUUID() }); expect(question.statusCode, question.body).toBe(200);
    const practice = question.json().session.practice; expect(practice.status).toBe('presented'); expect(practice.assessment.id).toBe(def.id);
    expect(JSON.stringify(practice.assessment)).not.toContain('grading');
    const before = modelCalls, payload = { text: String(def.grading.expected), requestId: randomUUID(), practiceResponse: { presentationId: practice.presentation.id, answer: { kind: 'numeric', value: def.grading.expected, unit: def.grading.canonicalUnit } } };
    const answer = await send(payload); expect(answer.statusCode, answer.body).toBe(200); expect(answer.json().session.practice.evaluation.correctness).toBe('correct');
    expect(modelCalls).toBe(before);
    const duplicate = await send(payload); expect(duplicate.statusCode, duplicate.body).toBe(200); expect(duplicate.json().session.revision).toBe(answer.json().session.revision); expect(modelCalls).toBe(before);
    expect((await send({ ...payload, text: 'A changed answer' })).statusCode).toBe(409);
    const unrelated = await send({ text: 'Explain this more simply', requestId: randomUUID() }); expect(unrelated.statusCode, unrelated.body).toBe(200);
    const learning = (await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers })).json(); expect(learning.attempts).toHaveLength(1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
