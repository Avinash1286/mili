import { createHash } from 'node:crypto';
import { AssessmentAnswerSchema, PracticeResponseSchema, TutorLearningActionSchema, TutorPracticeStateSchema, type AssessmentAnswer, type AssessmentDefinition, type AssessmentPresentation, type PracticeResponse, type Session, type TutorLearningAction } from '@tokai/contracts';
import { StoreError, type Principal, type Resource } from '@tokai/db';
import { applyAssistance, createPresentation, deriveMastery, evaluateAttempt, projectAssessment } from '@tokai/learning';
import { plainTeachingBeat, type PreparedLearningAction, type TutorLearningContext, type TutorReply } from '@tokai/tutor-core';
import { createGeminiRubricGrader } from '@tokai/tutor-core/learning';
import { liveModels, liveModelsConfigured } from './live-models.js';
import { definition, definitions, enqueueArtifact, metered, optionalResource, type AttemptRecord, type ProductContext } from './product-context.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableId = (kind: string, sessionId: string, turnId: string): string => `${kind}:${hash([sessionId, turnId]).slice(0, 48)}`;
type Input = { session: Session; turnId: string; text: string; practiceResponse?: PracticeResponse; mode: 'typed' | 'spoken'; signal?: AbortSignal };
type Prepared = { action: TutorLearningAction; canonical: PreparedLearningAction; def?: AssessmentDefinition; presentation?: Resource<AssessmentPresentation>; result?: AttemptRecord };
type Receipt = { action: TutorLearningAction; beatId: string; fingerprint: string; artifactId?: string };

/** Conservative, deterministic text binding. Ambiguous choices/units use the structured practice form. */
export function answerFromTutorInput(def: AssessmentDefinition, text: string, mode: 'typed' | 'spoken', turnId: string): AssessmentAnswer {
  const value = text.trim();
  if (def.kind === 'short-answer' || def.kind === 'spoken-explanation') return AssessmentAnswerSchema.parse({ kind: 'text', text: value, mode, ...(mode === 'spoken' ? { transcriptId: stableId('transcript', def.id, turnId) } : {}) });
  if (def.kind === 'multiple-choice') {
    const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[.!?]+$/, '').trim();
    const options = (def.options ?? []).filter(option => normalize(option.id) === normalize(value) || normalize(option.label) === normalize(value));
    if (options.length === 1) return { kind: 'choice', optionIds: [options[0]!.id] };
  }
  if (def.kind === 'numeric') {
    const match = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*[+-]?\d+)?(?:e[+-]?\d+)?)\s*([^\d\s].{0,29})?$/i);
    if (match) return { kind: 'numeric', value: match[1]!, unit: match[2]?.trim() ?? '' };
  }
  throw new StoreError(400, 'PRACTICE_ANSWER_AMBIGUOUS', 'Use the practice form to choose an option, enter a number and unit, or label the diagram. Your conversation has not been graded.');
}
function questionNarration(def: AssessmentDefinition): PreparedLearningAction {
  const assessment = projectAssessment(def), prompt = assessment.prompt;
  const full = [prompt, ...(assessment.options ?? []).map(option => `${option.id}: ${option.label}`), assessment.responseInstructions].filter(Boolean).join('\n');
  return { assessment, spokenText: prompt.length <= 520 ? `${prompt} Open Answer tutor question to submit your answer.` : 'A practice question is ready. Read the complete question and options in the practice panel, then submit your answer.', displayText: full.length <= 820 ? `${full}\n\nUse Answer tutor question to submit this question.` : 'A practice question is ready. Read its complete wording, options and instructions in the practice panel, then submit your answer.' };
}
function evaluationNarration(result: AttemptRecord): PreparedLearningAction {
  const lead = result.evaluation.correctness === 'uncertain' ? 'This answer could not be evaluated reliably.' : result.evaluation.correctness === 'correct' ? result.attempt.assisted ? 'Your answer is correct with help recorded.' : 'Your answer is correct for this question.' : result.evaluation.correctness === 'partial' ? 'Your answer is partially correct for this question.' : 'This answer needs another look.';
  const feedback = result.evaluation.feedback;
  return { spokenText: `${lead} ${feedback.length < 450 ? feedback : 'Read the saved feedback and reference explanation in the practice panel.'}`.slice(0, 600), displayText: `${lead}\n${feedback.length < 760 ? feedback : 'Read the complete saved feedback in the practice panel.'}`, feedback };
}

/** Provider work is completed before the caller's short commit transaction.
 * Returned commitLearning stages resources and mutates only the supplied session;
 * the caller must hold its owner/epoch fence and perform the one final save. */
export async function prepareLearningTurn(context: ProductContext, p: Principal, input: Input): Promise<{ learning: TutorLearningContext; answerReply?: TutorReply; finalize(reply: TutorReply): Promise<TutorReply> }> {
  const { store, env, now } = context;
  input.signal?.throwIfAborted();
  const owned = await store.get(p, input.session.id);
  if (owned.status !== 'active' || owned.mode !== input.session.mode || !input.turnId || input.turnId.length > 150) throw new StoreError(409, 'LESSON_ENDED', 'Resume an active lesson before submitting a practice answer.');
  const catalog = await definitions(store, p, input.session), response = input.practiceResponse ? PracticeResponseSchema.parse(input.practiceResponse) : undefined;
  let prepared: Prepared | undefined;
  const prepare = async (raw: TutorLearningAction): Promise<PreparedLearningAction> => {
    input.signal?.throwIfAborted(); const action = TutorLearningActionSchema.parse(raw);
    if (prepared) { if (hash(prepared.action) !== hash(action)) throw new StoreError(400, 'LEARNING_ACTION_LIMIT', 'Only one practice action is allowed per turn.'); return prepared.canonical; }
    if (action.type === 'ask_question') {
      const def = catalog.find(item => item.id === action.assessmentId && item.version === action.assessmentVersion);
      if (!def) throw new StoreError(404, 'ASSESSMENT_UNAVAILABLE', 'Choose an existing question from this lesson. Generate a question in Practice if none is available.');
      prepared = { action, def, canonical: questionNarration(def) };
    } else if (action.type === 'generate_flashcards') {
      prepared = { action, canonical: { spokenText: 'Review card generation is queued. You can follow its progress in your study pack.', displayText: 'Review card generation is queued. Follow its progress in Study pack; the cards are not ready yet.' } };
    } else {
      if (!response || response.presentationId !== action.presentationId) throw new StoreError(400, 'ANSWER_NOT_SUBMITTED', 'An explicit answer to the displayed practice question is required. Ordinary conversation is never graded.');
      const presentation = await store.resources.get<AssessmentPresentation>(p, 'presentation', response.presentationId);
      if (presentation.sessionId !== input.session.id) throw new StoreError(404, 'NOT_FOUND', 'Practice question not found.');
      const def = catalog.find(item => item.id === presentation.data.assessmentId && item.version === presentation.data.assessmentVersion);
      if (!def) throw new StoreError(409, 'ASSESSMENT_CHANGED', 'This question changed. Open its latest version before answering.');
      const attempts = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: input.session.id, limit: 200 });
      if (attempts.some(item => item.data.attempt.presentationId === presentation.id)) throw new StoreError(409, 'ATTEMPT_SUBMITTED', 'This presentation already has an answer. Open Practice to review it or start a fresh attempt.');
      const answer = response.answer ?? answerFromTutorInput(def, input.text, input.mode, input.turnId);
      // Structured input is the user's submitted payload, never a model tool argument.
      const submission = { attemptId: stableId('attempt', input.session.id, input.turnId), presentationId: presentation.id, assessmentId: def.id, assessmentVersion: def.version, answer };
      const grader = input.session.mode === 'live' && (context.providers?.rubric || liveModelsConfigured(env))
        ? (args: Parameters<ReturnType<typeof createGeminiRubricGrader>>[0]) => metered(context, p, 'model', 1, onUsage => (context.providers?.rubric ?? createGeminiRubricGrader({ ...liveModels(env), onUsage }))(args), { sessionId: input.session.id, traceId: input.turnId }) : undefined;
      const signal = AbortSignal.any([AbortSignal.timeout(45000), ...(input.signal ? [input.signal] : [])]);
      const evaluated = await evaluateAttempt(def, presentation.data, submission, { sessionId: input.session.id, evaluationId: stableId('evaluation', input.session.id, input.turnId), now: now(), rubricGrader: grader, signal });
      signal.throwIfAborted(); const result: AttemptRecord = { ...evaluated, fingerprint: hash(submission) };
      prepared = { action, def, presentation, result, canonical: evaluationNarration(result) };
    }
    return prepared.canonical;
  };
  const learning: TutorLearningContext = { assessments: catalog.map(projectAssessment), submittedPresentationId: response?.presentationId, prepare };
  let answerReply: TutorReply | undefined;
  if (response) {
    const action: TutorLearningAction = { type: 'evaluate_answer', presentationId: response.presentationId }, canonical = await prepare(action);
    answerReply = { text: canonical.displayText, beats: [{ ...plainTeachingBeat(canonical.spokenText), displayText: canonical.displayText, learningAction: action }] };
  }
  async function finalize(reply: TutorReply): Promise<TutorReply> {
    input.signal?.throwIfAborted();
    const actions = reply.beats?.filter(beat => beat.learningAction) ?? [];
    if (actions.length > 1) throw new StoreError(400, 'LEARNING_ACTION_LIMIT', 'Only one practice action is allowed per tutor turn.');
    if (!actions.length) return reply;
    const action = actions[0]!.learningAction!, canonical = await prepare(action);
    const beats = reply.beats!.map(beat => beat.learningAction ? { ...beat, spokenText: canonical.spokenText, displayText: canonical.displayText } : beat);
    return { ...reply, beats, text: beats.map(beat => beat.displayText).join('\n\n'), commitLearning: async (session, beatId) => {
      input.signal?.throwIfAborted();
      if (session.id !== input.session.id || session.status !== 'active') throw new StoreError(409, 'LEARNING_TURN_STALE', 'The practice turn no longer belongs to an active lesson.');
      const beat = session.teachingBeats?.find(item => item.beatId === beatId);
      if (!beat?.learningAction) return;
      if (beat.turnId !== input.turnId || hash(beat.learningAction) !== hash(action)) throw new StoreError(409, 'LEARNING_TURN_STALE', 'This practice action was cancelled or superseded.');
      const receiptId = stableId('learning', session.id, input.turnId), previous = await optionalResource<Receipt>(store, p, 'learning-action', receiptId);
      if (previous) { if (previous.sessionId !== session.id || previous.data.fingerprint !== hash(action)) throw new StoreError(409, 'IDEMPOTENCY_CONFLICT', 'This tutor turn already committed another practice action.'); return; }
      if (beat.status !== 'planned') throw new StoreError(409, 'LEARNING_TURN_STALE', 'This practice action was cancelled or superseded.');
      // Read the parent again inside the caller's transaction to establish owner/tombstone protection.
      await store.get(p, session.id);
      let artifactId: string | undefined;
      if (prepared!.def) {
        const latestDefinition = await definition(store, p, session, prepared!.def.id);
        if (hash(latestDefinition) !== hash(prepared!.def)) throw new StoreError(409, 'ASSESSMENT_CHANGED', 'The question changed while this response was being prepared.');
      }
      if (action.type === 'ask_question') {
        const previousPresentations = await store.resources.list<AssessmentPresentation>(p, 'presentation', { sessionId: session.id, limit: 200 });
        if (previousPresentations.length >= 200) throw new StoreError(429, 'PRACTICE_LIMIT', 'Start a new lesson to continue practice.');
        const def = prepared!.def!, attempts = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: session.id, limit: 200 });
        let presentation = createPresentation(def, stableId('presentation', session.id, input.turnId), now());
        const sameDay = (at: string) => at.slice(0, 10) === now().slice(0, 10);
        if (attempts.some(item => item.data.attempt.assessmentId === def.id && item.data.attempt.assessmentVersion === def.version && sameDay(item.data.attempt.submittedAt)) || previousPresentations.some(item => item.data.assessmentId === def.id && item.data.assessmentVersion === def.version && item.data.assistance.some(event => event.kind === 'answer-reveal' && sameDay(event.at)))) presentation = applyAssistance(def, presentation, { id: stableId('assistance', session.id, input.turnId), kind: 'answer-reveal', at: now() });
        await store.resources.put(p, 'presentation', presentation.id, presentation, { expectedRevision: -1, sessionId: session.id });
        session.practice = TutorPracticeStateSchema.parse({ assessment: projectAssessment(def), presentation, status: 'presented', turnId: input.turnId, beatId });
      } else if (action.type === 'evaluate_answer') {
        const current = await store.resources.get<AssessmentPresentation>(p, 'presentation', prepared!.presentation!.id);
        if (current.sessionId !== session.id || current.revision !== prepared!.presentation!.revision || hash(current.data) !== hash(prepared!.presentation!.data)) throw new StoreError(409, 'PRESENTATION_CHANGED', 'Help changed while evaluating. Submit with the updated practice record.');
        const attempts = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: session.id, limit: 200 });
        if (attempts.length >= 200 || attempts.some(item => item.data.attempt.presentationId === current.id)) throw new StoreError(409, 'ATTEMPT_SUBMITTED', 'This presentation already has an answer or reached the lesson practice limit.');
        const result = prepared!.result!;
        await store.resources.put(p, 'attempt', result.attempt.attemptId, result, { expectedRevision: -1, sessionId: session.id });
        session.practice = TutorPracticeStateSchema.parse({ assessment: projectAssessment(prepared!.def!), presentation: current.data, status: 'answered', turnId: input.turnId, beatId, attempt: result.attempt, evaluation: result.evaluation });
        const mastery = deriveMastery([...attempts.flatMap(item => item.data.evidence), ...result.evidence], now());
        const status = (id: string) => { const state = mastery.find(item => item.conceptId === id)?.state; return state === 'demonstrated' ? 'understood' as const : state === 'needs-review' ? 'needs-help' as const : state && state !== 'unknown' ? 'practicing' as const : 'introduced' as const; };
        session.concepts = session.concepts.map(concept => ({ ...concept, status: status(concept.id) }));
        if (session.conceptMap) { session.conceptMap.nodes = session.conceptMap.nodes.map(node => ({ ...node, status: node.status === 'question' ? 'question' : status(node.id) })); session.conceptMap.revision++; }
        await store.appendEvent(p, session.id, { id: stableId('event', session.id, input.turnId), type: 'assessment.evaluated', data: { attemptId: result.attempt.attemptId, evaluationId: result.evaluation.id } });
      } else artifactId = (await enqueueArtifact(context, p, session, 'cards')).id;
      await store.resources.put(p, 'learning-action', receiptId, { action, beatId, fingerprint: hash(action), ...(artifactId ? { artifactId } : {}) } satisfies Receipt, { expectedRevision: -1, sessionId: session.id });
    } };
  }
  return { learning, answerReply, finalize };
}
