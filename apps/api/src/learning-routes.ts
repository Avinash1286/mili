import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AssessmentPresentationSchema, SubmitAssessmentSchema, ReviewSubmissionSchema, LearningCardSchema, type AssessmentPresentation, type LearningCard, type ReviewReceipt } from '@tokai/contracts';
import { StoreError, type Principal } from '@tokai/db';
import { createPresentation, applyAssistance, projectAssessment, evaluateAttempt, deriveMastery, invalidateMasteryEvidence, reviseEvaluation, reviseCard, mergeDuplicateCards, createReviewReceipt, createCardSchedule } from '@tokai/learning';
import { createGeminiRubricGrader, generateLearningCards } from '@tokai/tutor-core/learning';
import { sources } from './artifact-jobs.js';
import { invalidateConcepts, invalidateStudyArtifacts } from './corrections.js';
import { synthesizeSpeech } from '@tokai/speech';
import { requestSignal } from './request-lifecycle.js';
import { principal, parse, optionalResource, authoredPack, definition, definitions, initializeLearning, learningData, enqueueArtifact, reflectMastery, preferences, metered, bumpSession, type AttemptRecord, type ProductContext } from './product-context.js';

type SessionParams = { id: string }; type PresentationParams = SessionParams & { presentationId: string };
const fingerprint = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export async function registerLearning(app: FastifyInstance, context: ProductContext) {
  const { store, env, now } = context;
  const grading = new Set<string>();
  const grader = (p: Principal, sessionId: string): ReturnType<typeof createGeminiRubricGrader> | undefined => context.providers?.rubric || env.GEMINI_API_KEY && env.GEMINI_MODEL ? input => metered(context, p, 'model', 1, onUsage => (context.providers?.rubric ?? createGeminiRubricGrader({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL!, onUsage }))(input), { sessionId }) : undefined;
  app.get<{ Params: SessionParams }>('/v1/sessions/:id/learning', async request => {
    const p = await principal(request, store);
    await store.locked(request.params.id, async () => initializeLearning(context, p, await store.get(p, request.params.id)));
    return learningData(context, p, await store.get(p, request.params.id));
  });
  app.post<{ Params: SessionParams }>('/v1/sessions/:id/assessments', async request => {
    const p = await principal(request, store), input = parse(z.object({ assessmentId: z.string().min(1).max(100) }).strict(), request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(p, request.params.id), def = await definition(store, p, session, input.assessmentId);
      const previous = await store.resources.list<AssessmentPresentation>(p, 'presentation', { sessionId: session.id, limit: 200 });
      if (previous.length >= 200) throw new StoreError(429, 'PRACTICE_LIMIT', 'Start a new lesson to continue practice.');
      let presentation = createPresentation(def, randomUUID(), now());
      // Immediate retries retain assistance; a fresh presentation on a later UTC day can measure spaced recall.
      const answered = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: session.id, limit: 200 });
      if (answered.some(item => item.data.attempt.assessmentId === def.id && item.data.attempt.assessmentVersion === def.version && item.data.attempt.submittedAt.slice(0, 10) === now().slice(0, 10)) || previous.some(item => item.data.assessmentId === def.id && item.data.assessmentVersion === def.version && item.data.assistance.some(event => event.kind === 'answer-reveal' && event.at.slice(0, 10) === now().slice(0, 10)))) {
        presentation = applyAssistance(def, presentation, { id: randomUUID(), kind: 'answer-reveal', at: now() });
      }
      await store.resources.put(p, 'presentation', presentation.id, presentation, { expectedRevision: -1, sessionId: session.id });
      return { assessment: projectAssessment(def), presentation };
    });
  });
  for (const mode of ['hint', 'reveal'] as const) app.post<{ Params: PresentationParams }>(`/v1/sessions/:id/assessments/:presentationId/${mode}`, async request => {
    const p = await principal(request, store), input = parse(z.object({ hintId: z.string().max(100).optional() }).strict(), request.body ?? {});
    return store.locked(request.params.id, async () => {
      const session = await store.get(p, request.params.id), record = await store.resources.get<AssessmentPresentation>(p, 'presentation', request.params.presentationId);
      if (record.sessionId !== session.id) throw new StoreError(404, 'NOT_FOUND', 'Practice question not found.');
      const def = await definition(store, p, session, record.data.assessmentId);
      if ((await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: session.id, limit: 200 })).some(item => item.data.attempt.presentationId === record.id)) throw new StoreError(409, 'ATTEMPT_SUBMITTED', 'This attempt was submitted. Start another attempt for more help.');
      const hint = mode === 'hint' ? (input.hintId ? def.hints.find(value => value.id === input.hintId) : def.hints.find(value => !record.data.assistance.some(event => event.hintId === value.id))) : undefined;
      if (mode === 'hint' && !hint) throw new StoreError(404, 'HINT_UNAVAILABLE', 'No more hints are available for this question.');
      const presentation = applyAssistance(def, record.data, { id: randomUUID(), kind: mode === 'hint' ? 'hint' : 'answer-reveal', hintId: hint?.id, at: now() });
      await store.resources.put(p, 'presentation', record.id, presentation, { expectedRevision: record.revision, sessionId: session.id });
      if (session.practice?.presentation.id === presentation.id) { session.practice.presentation = presentation; await store.save(p, bumpSession(session, now())); }
      return mode === 'hint' ? { hint, presentation } : { explanation: def.explanation, presentation };
    });
  });
  app.post<{ Params: SessionParams }>('/v1/sessions/:id/attempts', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const p = await principal(request, store), input = parse(SubmitAssessmentSchema, request.body), hash = fingerprint(input);
    const existing = await optionalResource<AttemptRecord>(store, p, 'attempt', input.attemptId);
    if (existing) { if (existing.sessionId !== request.params.id || existing.data.fingerprint !== hash) throw new StoreError(409, 'IDEMPOTENCY_CONFLICT', 'This attempt ID already represents another answer.'); return { attempt: existing.data.attempt, evaluation: existing.data.evaluation, mastery: (await learningData(context, p, await store.get(p, request.params.id))).mastery }; }
    const key = `${p.ownerId}:${input.presentationId}`;
    if (grading.has(key)) throw new StoreError(409, 'GRADING_ACTIVE', 'This answer is already being evaluated.');
    grading.add(key);
    try {
      const session = await store.get(p, request.params.id), def = await definition(store, p, session, input.assessmentId), record = await store.resources.get<AssessmentPresentation>(p, 'presentation', input.presentationId);
      if (record.sessionId !== session.id) throw new StoreError(404, 'NOT_FOUND', 'Practice question not found.');
      const result = await evaluateAttempt(def, AssessmentPresentationSchema.parse(record.data), input, { sessionId: session.id, evaluationId: randomUUID(), now: now(), rubricGrader: session.mode === 'live' ? grader(p, session.id) : undefined, signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(45000)]) });
      return await store.locked(session.id, async () => {
        const latestSession = await store.get(p, session.id);
        const current = await store.resources.get<AssessmentPresentation>(p, 'presentation', record.id);
        if (current.revision !== record.revision) throw new StoreError(409, 'PRESENTATION_CHANGED', 'Help changed while evaluating. Submit again with the updated practice record.');
        const all = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: session.id, limit: 200 });
        if (all.some(item => item.data.attempt.presentationId === record.id)) throw new StoreError(409, 'ATTEMPT_SUBMITTED', 'This presentation already has an answer. Start another attempt.');
        if (all.length >= 200) throw new StoreError(429, 'PRACTICE_LIMIT', 'Start a new lesson to continue practice.');
        if (input.retryOf && !all.some(item => item.id === input.retryOf && item.data.attempt.assessmentId === input.assessmentId)) throw new StoreError(400, 'INVALID_RETRY', 'The earlier attempt must belong to this question and lesson.');
        await store.resources.put(p, 'attempt', input.attemptId, { ...result, fingerprint: hash } satisfies AttemptRecord, { expectedRevision: -1, sessionId: session.id });
        await store.appendEvent(p, session.id, { id: randomUUID(), type: 'assessment.evaluated', data: { attemptId: input.attemptId, evaluationId: result.evaluation.id } });
        const mastery = deriveMastery([...all.flatMap(item => item.data.evidence), ...result.evidence], now());
        if (latestSession.practice?.presentation.id === result.attempt.presentationId) latestSession.practice = { ...latestSession.practice, presentation: current.data, status: 'answered', attempt: result.attempt, evaluation: result.evaluation };
        await reflectMastery(context, p, latestSession, mastery);
        return { attempt: result.attempt, evaluation: result.evaluation, mastery, session: await store.get(p, session.id) };
      });
    } finally { grading.delete(key); }
  });
  app.post<{ Params: SessionParams & { attemptId: string } }>('/v1/sessions/:id/attempts/:attemptId/appeal', async request => {
    const p = await principal(request, store), input = parse(z.object({ reason: z.string().trim().min(3).max(2000) }).strict(), request.body);
    const session = await store.get(p, request.params.id), previous = await store.resources.get<AttemptRecord>(p, 'attempt', request.params.attemptId);
    if (previous.sessionId !== session.id) throw new StoreError(404, 'NOT_FOUND', 'Attempt not found.');
    const def = await definition(store, p, session, previous.data.attempt.assessmentId);
    // A dispute immediately removes the contested evidence; an unavailable adjudicator never fabricates a corrected success.
    const corrected = reviseEvaluation(def, previous.data.attempt, previous.data.evaluation, { correctness: 'uncertain', reasoning: 'uncertain', confidence: 'low', method: 'adjudicated', criteria: [], misconceptionIds: [], feedback: 'You disputed this result. Its mastery evidence has been withdrawn. Compare the source explanation or try a fresh question; this appeal is saved for review.' }, { id: randomUUID(), now: now() });
    return store.locked(session.id, async () => {
      const latestSession = await store.get(p, session.id);
      const current = await store.resources.get<AttemptRecord>(p, 'attempt', previous.id);
      if (current.revision !== previous.revision) throw new StoreError(409, 'VERSION_CONFLICT', 'This attempt changed. Refresh it before appealing.');
      await store.resources.put(p, 'appeal', randomUUID(), { reason: input.reason, evaluation: previous.data.evaluation, attemptId: previous.id, createdAt: now() }, { expectedRevision: -1, sessionId: session.id });
      const data = { ...previous.data, evaluation: corrected.evaluation, evidence: [...invalidateMasteryEvidence(previous.data.evidence, previous.data.evaluation.id, input.reason.slice(0, 500), now()), ...corrected.evidence] };
      await store.resources.put(p, 'attempt', previous.id, data, { expectedRevision: previous.revision, sessionId: session.id });
      const mastery = (await learningData(context, p, latestSession)).mastery;
      if (latestSession.practice?.attempt?.attemptId === data.attempt.attemptId) latestSession.practice = { ...latestSession.practice, evaluation: data.evaluation };
      await reflectMastery(context, p, latestSession, mastery);
      await invalidateStudyArtifacts(context, p, session.id, 'An assessment result was appealed. Its earlier feedback and mastery evidence have been withdrawn. Regenerate derived artifacts before using them.');
      return { attempt: data.attempt, evaluation: data.evaluation, mastery };
    });
  });
  app.post<{ Params: SessionParams }>('/v1/sessions/:id/generate-assessment', async request => {
    const p = await principal(request, store);
    return store.locked(request.params.id, async () => ({ artifact: await enqueueArtifact(context, p, await store.get(p, request.params.id), 'assessment') }));
  });
  app.get('/v1/reviews/due', async request => {
    const p = await principal(request, store), cards = (await store.resources.list<LearningCard>(p, 'card', { limit: 1000 })).map(item => item.data).filter(card => card.status === 'active' && card.schedule.dueAt <= now()).sort((a, b) => a.schedule.dueAt.localeCompare(b.schedule.dueAt));
    return { cards: cards.slice(0, 100), total: cards.length };
  });
  app.patch<{ Params: SessionParams }>('/v1/flashcards/:id', async request => {
    const p = await principal(request, store), input = parse(z.object({ revision: z.number().int().positive(), front: z.string().min(1).max(1000).optional(), back: z.string().min(1).max(3000).optional(), hint: z.string().max(1000).optional(), explanation: z.string().max(3000).optional(), cloze: LearningCardSchema.shape.cloze.optional(), status: z.enum(['active', 'discarded', 'needs-correction']).optional() }).strict(), request.body);
    return store.locked(`card:${request.params.id}`, async () => {
      const record = await store.resources.get<LearningCard>(p, 'card', request.params.id);
      if (record.data.revision !== input.revision) throw new StoreError(409, 'VERSION_CONFLICT', 'This card changed. Refresh it before editing.');
      const { revision: _, ...changes } = input, card = reviseCard(record.data, changes, now());
      await store.resources.put(p, 'card', card.id, card, { expectedRevision: record.revision, sessionId: record.sessionId });
      if (input.status === 'needs-correction' || input.back !== undefined && input.back !== record.data.back || input.cloze !== undefined && JSON.stringify(input.cloze) !== JSON.stringify(record.data.cloze)) await invalidateConcepts(context, p, card.originSessionId, card.conceptIds, 'A learner corrected a related review card.', card.id);
      return { card };
    });
  });
  app.post<{ Params: SessionParams }>('/v1/flashcards/:id/regenerate', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    const p = await principal(request, store);
    const record = await store.resources.get<LearningCard>(p, 'card', request.params.id), old = record.data;
    if (old.status === 'merged') throw new StoreError(409, 'CARD_MERGED', 'Regenerate the retained card after a merge.');
    const session = await store.get(p, old.originSessionId);
    let template = authoredPack(session)?.cardTemplates.find(item => item.id === old.templateId);
    const references = await sources(context, p, session);
    if (!template) {
      if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL) throw new StoreError(503, 'GENERATION_UNAVAILABLE', 'Live card regeneration is not configured. You can edit the correction directly.');
      const rubricAssessments = (await definitions(store, p, session)).filter(item => item.grading.type === 'rubric' && (old.kind !== 'spoken-recall' || item.id === old.rubricAssessmentId));
      if (old.kind === 'spoken-recall' && !rubricAssessments.length) throw new StoreError(409, 'CARD_RUBRIC_UNAVAILABLE', 'The original recall rubric is unavailable. Edit this card directly or generate a new question before regenerating it.');
      const generated = await metered(context, p, 'model', 1, onUsage => (context.providers?.cards ?? generateLearningCards)({ session: { ...session, lessonFocus: { goal: `Correct this ${old.kind} card: ${old.front}. Check: ${old.back}`.slice(0, 500), nextStep: 'Generate a corrected card for the same concept and format.', phase: 'practice' } }, sourceRefs: references.refs.slice(-12), rubricAssessments, apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL!, signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(45000)]), onUsage }), { sessionId: session.id });
      template = generated.find(card => card.kind === old.kind && card.conceptIds.some(id => old.conceptIds.includes(id)) && (old.kind !== 'spoken-recall' || card.rubricAssessmentId === old.rubricAssessmentId));
      if (!template) throw new StoreError(503, 'CARD_GENERATION_FAILED', 'The generated correction did not preserve this card type and concept. Your original card is unchanged.');
    }
    const { id: templateId, ...content } = template;
    const card = LearningCardSchema.parse({ ...old, ...content, templateId, revision: old.revision + 1, status: 'active', updatedAt: now(), schedule: { ...createCardSchedule(now()), revision: old.schedule.revision + 1 } });
    return store.locked(`card:${request.params.id}`, async () => {
      const current = await store.resources.get<LearningCard>(p, 'card', record.id);
      if (current.revision !== record.revision || (await store.get(p, session.id)).revision !== session.revision) throw new StoreError(409, 'VERSION_CONFLICT', 'The card or lesson changed during regeneration. Retry against the latest version.');
      for (const source of references.resources) if ((await store.resources.get(p, 'source', source.id)).revision !== source.revision) throw new StoreError(409, 'SOURCE_CHANGED', 'A source changed during regeneration.');
      await store.resources.put(p, 'card', card.id, card, { expectedRevision: record.revision, sessionId: record.sessionId });
      await invalidateConcepts(context, p, card.originSessionId, card.conceptIds, 'A related review card was regenerated.', card.id);
      return { card };
    });
  });
  app.post<{ Params: SessionParams }>('/v1/flashcards/:id/merge', async request => {
    const p = await principal(request, store), input = parse(z.object({ targetId: z.string().min(1).max(100) }).strict(), request.body);
    return store.locked(`owner:${p.ownerId}`, async () => {
      const records = await Promise.all([store.resources.get<LearningCard>(p, 'card', request.params.id), store.resources.get<LearningCard>(p, 'card', input.targetId)]);
      const merged = mergeDuplicateCards(records.map(item => item.data), input.targetId, now());
      for (const card of merged) { const record = records.find(item => item.id === card.id)!; await store.resources.put(p, 'card', card.id, card, { expectedRevision: record.revision, sessionId: record.sessionId }); }
      return { card: merged.find(card => card.id === input.targetId)! };
    });
  });
  app.post<{ Params: SessionParams }>('/v1/reviews/:id/attempts', async request => {
    const p = await principal(request, store), input = parse(ReviewSubmissionSchema, request.body);
    if (input.cardId !== request.params.id) throw new StoreError(400, 'INVALID_CARD', 'Review the displayed card.');
    return store.locked(`owner:${p.ownerId}`, async () => {
      const record = await store.resources.get<LearningCard>(p, 'card', input.cardId), existing = await optionalResource<ReviewReceipt>(store, p, 'review', input.reviewId);
      const receipt = createReviewReceipt(record.data, input, now(), existing?.data);
      if (!existing) {
        await store.resources.put(p, 'review', input.reviewId, receipt, { expectedRevision: -1, sessionId: record.sessionId });
        await store.resources.put(p, 'card', record.id, { ...record.data, schedule: receipt.schedule, updatedAt: now() }, { expectedRevision: record.revision, sessionId: record.sessionId });
      }
      return { receipt };
    });
  });
  app.post<{ Params: SessionParams }>('/v1/reviews/:id/answer', async request => {
    const p = await principal(request, store), input = parse(z.object({ text: z.string().trim().min(1).max(3000), mode: z.enum(['typed', 'spoken']) }).strict(), request.body);
    const { data: card } = await store.resources.get<LearningCard>(p, 'card', request.params.id);
    const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[.!?]+$/, '').trim();
    const matches = normalize(input.text) === normalize(card.back);
    return { feedback: matches ? 'Your answer exactly matches the reference. Choose how difficult recall felt.' : 'Compare your explanation with the reference. Wording differences cannot be graded reliably by this comparison; choose your own recall rating.', suggestedRating: matches ? 'good' : 'hard' };
  });
  app.post<{ Params: SessionParams }>('/v1/reviews/:id/speech', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = await principal(request, store), { data: card } = await store.resources.get<LearningCard>(p, 'card', request.params.id);
    const session = await store.get(p, card.originSessionId), speechPreferences = session.settings?.preferences ?? (await preferences(store, p)).preferences;
    if (!env.ASSEMBLYAI_API_KEY) throw new StoreError(503, 'SPEECH_UNAVAILABLE', 'Speech is not configured.');
    const result = await metered(context, p, 'speech', [...card.front.trim()].length, () => (context.providers?.speech ?? synthesizeSpeech)({ text: card.front, voiceId: speechPreferences.voiceId, language: speechPreferences.language, apiKey: env.ASSEMBLYAI_API_KEY!, signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(25000)]) }), { sessionId: session.id });
    await store.resources.get(p, 'card', card.id); await store.get(p, session.id);
    return reply.header('Cache-Control', 'no-store').type(result.contentType).send(result.audio);
  });
}
