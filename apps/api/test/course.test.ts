import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpeechError } from '@milli/speech';
import { createApp } from '../src/app.js';

describe('step-by-step adaptive course routes', () => {
  let dataDir = '';
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'milli-course-test-'));
    app = await createApp({ dataDir, rateLimit: false, env: { ASSEMBLYAI_API_KEY: 'test-speech-key' } });
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('starts a course fast, handles side-questions + bridge-back, spoken answers, and splices remedial steps', async () => {
    const guestRes = await app.inject({ method: 'POST', url: '/v1/guest-sessions', payload: {} });
    expect(guestRes.statusCode).toBe(201);
    const { token } = guestRes.json() as { token: string };
    const headers = { Authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/courses/start',
      headers,
      payload: { topic: 'solar-system', mode: 'sample', goal: '', sourceIds: [], grounding: 'general' },
    });
    expect(createRes.statusCode).toBe(201);
    const { session } = createRes.json() as { session: { id: string } };

    const courseRes = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/course`, headers });
    expect(courseRes.statusCode).toBe(200);
    const courseData = courseRes.json() as { script: { chapters: { steps: { id: string }[] }[] }; progress: { xp: number }; revision: number };
    expect(courseData.script.chapters.length).toBeGreaterThan(0);
    const firstStepId = courseData.script.chapters[0]!.steps[0]!.id;
    expect(firstStepId).toBe('ss-1');

    // Learner ignores the active question and asks an off-script side question -> tutor answers AND bridges back
    const sideTurnRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/course-turn`,
      headers,
      payload: {
        stepId: 'ss-1',
        event: 'learner-message',
        mode: 'typed',
        learnerText: 'Wait, why do leap years even exist in astronomy?',
        stage: 'practice',
        attempts: 0,
      },
    });
    expect(sideTurnRes.statusCode).toBe(200);
    const sideTurn = sideTurnRes.json() as { reply: { intent: string; displayText: string; bridgeText?: string; replies: string[] } };
    expect(sideTurn.reply.intent).toBe('side-question');
    expect(sideTurn.reply.bridgeText).toBeTruthy();
    expect(sideTurn.reply.replies).toContain('Back to question');

    // Learner speaks the correct answer to ss-2 ("2 and 6") -> tutor marks step solved!
    const spokenRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/course-turn`,
      headers,
      payload: {
        stepId: 'ss-2',
        event: 'learner-message',
        mode: 'spoken',
        learnerText: 'The peaks are at 2 and 6',
        stage: 'practice',
        attempts: 0,
      },
    });
    expect(spokenRes.statusCode).toBe(200);
    const spokenTurn = spokenRes.json() as { reply: { intent: string; markStepSolved: boolean } };
    expect(spokenTurn.reply.intent).toBe('spoken-answer');
    expect(spokenTurn.reply.markStepSolved).toBe(true);

    // Repeated wrong attempts trigger a spliced remedial stepping-stone step
    const beforeStepsCount = courseData.script.chapters[0]!.steps.length;
    const remRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/course-turn`,
      headers,
      payload: {
        stepId: 'ss-2',
        event: 'check',
        mode: 'ui',
        correct: false,
        attempts: 2,
        stage: 'practice',
      },
    });
    expect(remRes.statusCode).toBe(200);
    const remTurn = remRes.json() as { reply: { intent: string; insertedStep?: { id: string } }; script: { chapters: { steps: { id: string }[] }[] } };
    expect(remTurn.reply.intent).toBe('remedial');
    expect(remTurn.reply.insertedStep?.id).toBeTruthy();
    expect(remTurn.script.chapters[0]!.steps.length).toBe(beforeStepsCount + 1);

    // Save progress and check legacy course-help endpoint compatibility
    const saveRes = await app.inject({
      method: 'PUT',
      url: `/v1/sessions/${session.id}/course-progress`,
      headers,
      payload: {
        revision: courseData.revision,
        progress: {
          chapter: 0,
          step: 1,
          stage: 'teach',
          xp: 15,
          results: { [firstStepId]: { correct: true, attempts: 1, revealed: false, xp: 15 } },
          history: [],
        },
      },
    });
    expect(saveRes.statusCode).toBe(200);
    expect((saveRes.json() as { progress: { xp: number } }).progress.xp).toBe(15);

    const helpRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${session.id}/course-help`,
      headers,
      payload: { stepId: 'ss-2', text: 'Why?', mode: 'typed', attempts: 1, status: 'correct' },
    });
    expect(helpRes.statusCode).toBe(200);
    const { reply } = helpRes.json() as { reply: { text: string; replies: string[]; source: string } };
    expect(reply.source).toBe('prepared');
    expect(reply.text).toContain('repeats every 4 years');
    expect(reply.replies).toContain('Yes');
  });

  it('returns 503 with chat-continuation notice when AssemblyAI TTS is unreachable or unconfigured', async () => {
    const failingDir = await mkdtemp(path.join(os.tmpdir(), 'milli-speech-fail-'));
    const failingApp = await createApp({
      dataDir: failingDir,
      rateLimit: false,
      env: { ASSEMBLYAI_API_KEY: 'test-speech-key' },
      speech: async () => {
        throw new SpeechError('provider-error', 'AssemblyAI upstream unreachable');
      },
    });

    try {
      const guestRes = await failingApp.inject({ method: 'POST', url: '/v1/guest-sessions', payload: {} });
      const { token } = guestRes.json() as { token: string };
      const headers = { Authorization: `Bearer ${token}` };

      const createRes = await failingApp.inject({
        method: 'POST',
        url: '/v1/courses/start',
        headers,
        payload: { topic: 'solar-system', mode: 'sample', goal: '', sourceIds: [], grounding: 'general' },
      });
      const { session } = createRes.json() as { session: { id: string } };

      const speechRes = await failingApp.inject({
        method: 'POST',
        url: `/v1/sessions/${session.id}/course-speech`,
        headers,
        payload: { stepId: 'ss-1', part: 'concept' },
      });
      expect(speechRes.statusCode).toBe(503);
      const errBody = speechRes.json() as { code: string; message: string };
      expect(errBody.code).toBe('SPEECH_FAILED');
      expect(errBody.message).toContain('AssemblyAI speech is unreachable');
      expect(errBody.message).toContain('Continue the lesson with chat');
    } finally {
      await failingApp.close();
      await rm(failingDir, { recursive: true, force: true });
    }
  });
});
