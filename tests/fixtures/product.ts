// Test-only simulated learning providers. Nothing in apps/web imports authored answer keys.
import { getLessonPack } from '../../packages/learning/src/index.js';
import { deterministicAgenticTurn, generateInitialCourse, generateNextCourseChapter, getAuthoredCourseScript } from '../../packages/tutor-core/src/index.js';
import type { ProductProviders } from '../../apps/api/src/product-context.js';
import type { Store } from '../../packages/db/src/index.js';
import type { createApp } from '../../apps/api/src/app.js';

export const productProviders: ProductProviders = {
  courseInitial: async input => {
    const authored = getAuthoredCourseScript(input.topic);
    if (authored && input.settings?.grounding !== 'sources-only') {
      return { ...structuredClone(authored), provenance: 'generated' };
    }
    const generated = await generateInitialCourse({ ...input, mode: 'sample', apiKey: '', model: '' });
    return { ...generated, provenance: 'generated' };
  },
  courseChapter: async input => generateNextCourseChapter({ ...input, apiKey: '', model: '' }),
  courseTurn: async input => deterministicAgenticTurn(input.course, input.step, input.request),
  recap: async input => ({
    speak: async (text, options = {}) => {
      const identity = { providerSessionId: 'recap-fixture', flushId: 0 }; options.signal?.throwIfAborted(); options.onStart?.(identity);
      input.onAudio(new Uint8Array(24000), identity); options.onDone?.({ ...identity, audioDurationMs: 500 });
      input.onBoundaries?.({ ...identity, audioStartMs: 0, words: [{ word: text.split(/\s+/)[0] || 'Recap', startMs: 0, endMs: 500, confidence: 1 }] });
    }, cancel: async () => {}, close: () => {},
  }),
  transcriber: async input => {
    let closed = false, samples = 0;
    return { sendAudio: pcm => { if (!closed) samples += pcm.length / 2; }, forceEndpoint: () => { if (!closed && samples) input.onFinal({ providerSessionId: 'dictation-fixture', turnId: 'dictation-fixture:0', turnOrder: 0, text: 'The denominator tells us the whole is divided into four equal parts.' }); }, close: () => { closed = true; } };
  },
  plan: async ({ topic, settings }) => ({ version: 1, goal: settings.goal || topic, level: settings.preferences.level, minutes: settings.preferences.lessonMinutes, objectives: [`Explain ${topic} using a concrete example.`], prerequisites: ['Bring one question.'], steps: [{ title: 'Explore', objective: `Explain ${topic} using a concrete example.` }], provenance: 'generated', status: 'ready' }),
  assessment: async ({ session, id, kind }) => {
    const pack = getLessonPack(session.topic) || getLessonPack('photosynthesis')!;
    const original = pack.assessments.find(item => item.kind === kind)!;
    return { ...structuredClone(original), id, version: 'fixture-v1', packId: `session:${session.id}`, prompt: `Fixture practice: ${original.prompt}` };
  },
  cards: async ({ session }) => structuredClone((getLessonPack(session.topic) || getLessonPack('photosynthesis')!).cardTemplates.slice(0, 2)),
  rubric: async ({ rubric }) => ({ correctness: 'uncertain', reasoning: 'uncertain', confidence: 'low', criteria: rubric.criteria.map(item => ({ criterionId: item.id, judgment: 'uncertain' })), feedback: 'Fixture rubric is deliberately uncertain; this is not an independent mastery claim.', misconceptionIds: [] }),
};

/** Exercise the real leased job executor using isolated files, without a Convex deployment. */
export function fixtureWorker(app: Awaited<ReturnType<typeof createApp>>, store: Store, secret: string) {
  let stopping = false, running: Promise<void> | undefined;
  const workerId = 'product-e2e-worker';
  async function tick() {
    for (const job of await store.outbox.claim(workerId, 1, 120000)) {
      if (stopping) return;
      const response = await app.inject({ method: 'POST', url: '/internal/jobs/execute', headers: { 'x-tokai-job-secret': secret }, payload: { jobId: job.id, workerId, fence: job.fence } });
      if (response.statusCode === 200) await store.outbox.complete(job.id, workerId, job.fence);
      else await store.outbox.fail(job.id, workerId, job.fence, { code: 'FIXTURE_EXECUTOR_FAILED', ...(job.attempts < 3 ? { retryAt: new Date(Date.now() + 100).toISOString() } : {}) });
    }
  }
  const timer = setInterval(() => { if (stopping || running) return; running = tick().catch(error => { console.error('Fixture worker failed:', error instanceof Error ? error.name : 'unknown'); }).finally(() => { running = undefined; }); }, 200);
  timer.unref();
  return async () => { stopping = true; clearInterval(timer); await running; };
}
