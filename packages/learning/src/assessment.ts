import {
  AssessmentAnswerSchema, AssessmentAttemptSchema, AssessmentDefinitionSchema, AssessmentEvaluationSchema,
  AssessmentPresentationSchema, AssistanceEventSchema, PublicAssessmentSchema, RubricJudgmentSchema,
  SubmitAssessmentSchema, MasteryEvidenceSchema,
  type AssessmentAnswer, type AssessmentAttempt, type AssessmentDefinition, type AssessmentEvaluation,
  type AssessmentPresentation, type AssistanceEvent, type ExplanationRubric, type LearningSourceRef,
  type MasteryEvidence, type PublicAssessment, type SubmitAssessment,
} from '@tokai/contracts';
import { absoluteDifference, check, compareRational, configurationNumber, equalRational, immutable, multiply, normalizeText, parseNumeric, printRational, timestamp, unique } from './common';

export type GradingDecision = Pick<AssessmentEvaluation, 'correctness' | 'reasoning' | 'confidence' | 'method' | 'criteria' | 'feedback' | 'misconceptionIds' | 'normalizedAnswer'>;
export type RubricGrader = (input: { assessment: PublicAssessment; rubric: ExplanationRubric; answer: string; sourceRefs: LearningSourceRef[]; signal?: AbortSignal }) => Promise<unknown>;
export function projectAssessment(input: AssessmentDefinition): PublicAssessment {
  const definition = AssessmentDefinitionSchema.parse(input);
  const { hints, explanation: _explanation, sourceRefs: _sourceRefs, grading, ...publicFields } = definition;
  return immutable(PublicAssessmentSchema.parse({ ...publicFields, hintCount: hints.length, ...(grading.type === 'labels' ? { targetIds: grading.targets.map(item => item.targetId) } : {}) }));
}
export function createPresentation(definition: AssessmentDefinition, id: string, now: string): AssessmentPresentation {
  timestamp(now); AssessmentDefinitionSchema.parse(definition);
  return immutable(AssessmentPresentationSchema.parse({ id, assessmentId: definition.id, assessmentVersion: definition.version, createdAt: now, revision: 0, assistance: [] }));
}
function validatePresentation(definition: AssessmentDefinition, presentation: AssessmentPresentation, now?: string): void {
  check(presentation.assessmentId === definition.id && presentation.assessmentVersion === definition.version, 'VERSION_CONFLICT', 'The presented assessment version does not match.');
  const created = timestamp(presentation.createdAt), end = now ? timestamp(now) : Infinity;
  check(created <= end, 'INVALID_TIME', 'The presentation cannot be in the future.');
  check(unique(presentation.assistance.map(item => item.id)).length === presentation.assistance.length, 'INVALID_ASSISTANCE', 'Assistance events must be unique.');
  for (const event of presentation.assistance) {
    check(timestamp(event.at) >= created && timestamp(event.at) <= end, 'INVALID_TIME', 'Assistance timestamps must belong to this attempt.');
    check(event.kind === 'hint' ? definition.hints.some(hint => hint.id === event.hintId) : !event.hintId, 'INVALID_ASSISTANCE', 'This help event does not match the assessment.');
  }
}
export function applyAssistance(definition: AssessmentDefinition, input: AssessmentPresentation, rawEvent: AssistanceEvent): AssessmentPresentation {
  AssessmentDefinitionSchema.parse(definition);
  const presentation = AssessmentPresentationSchema.parse(input), event = AssistanceEventSchema.parse(rawEvent);
  validatePresentation(definition, presentation);
  const existing = presentation.assistance.find(item => item.id === event.id);
  if (existing) { check(existing.kind === event.kind && existing.hintId === event.hintId && existing.at === event.at, 'IDEMPOTENCY_CONFLICT', 'This help event ID already represents a different event.'); return immutable(presentation); }
  const next = AssessmentPresentationSchema.parse({ ...presentation, revision: presentation.revision + 1, assistance: [...presentation.assistance, event] });
  validatePresentation(definition, next); return immutable(next);
}

function decision(correctness: GradingDecision['correctness'], feedback: string, extra: Partial<GradingDecision> = {}): GradingDecision {
  return { correctness, reasoning: 'not-assessed', confidence: 'high', method: 'deterministic', criteria: [], feedback, misconceptionIds: [], ...extra };
}
const uncertain = (feedback: string): GradingDecision => decision('uncertain', feedback, { confidence: 'low', reasoning: 'uncertain', method: 'unavailable' });

/** Returns undefined only when a free-form answer needs the injected rubric grader. */
export function gradeDeterministic(input: AssessmentDefinition, rawAnswer: AssessmentAnswer): GradingDecision | undefined {
  const definition = AssessmentDefinitionSchema.parse(input), answer = AssessmentAnswerSchema.parse(rawAnswer), rule = definition.grading;
  if (rule.type === 'choice') {
    check(answer.kind === 'choice', 'INVALID_ANSWER', 'Choose an option for this question.');
    check(unique(answer.optionIds).length === answer.optionIds.length && answer.optionIds.every(id => definition.options!.some(option => option.id === id)), 'INVALID_ANSWER', 'Choose only valid, distinct options.');
    const correct = answer.optionIds.length === rule.correctOptionIds.length && answer.optionIds.every(id => rule.correctOptionIds.includes(id));
    const partial = !correct && answer.optionIds.every(id => rule.correctOptionIds.includes(id));
    return decision(correct ? 'correct' : partial ? 'partial' : 'incorrect', correct ? 'Your selected answer matches the stated problem.' : partial ? 'You selected part of the answer; another correct option is missing.' : 'Revisit the relationship in the explanation before trying a fresh question.');
  }
  if (rule.type === 'numeric') {
    check(answer.kind === 'numeric', 'INVALID_ANSWER', 'Enter a number and its unit for this question.');
    if (rule.unitRequired && !answer.unit) return uncertain('A unit is needed to interpret this number. Add a compatible unit and try again.');
    const unit = rule.acceptedUnits.find(item => item.unit.normalize('NFKC').trim() === answer.unit.normalize('NFKC').trim());
    if (!unit) return decision('incorrect', `The unit does not match this quantity. Use ${rule.canonicalUnit || 'a dimensionless number'} or an explicitly supported equivalent.`);
    let value;
    try { value = multiply(parseNumeric(answer.value), parseNumeric(unit.factor)); }
    catch { return uncertain('I could not interpret the number safely. Use a decimal, scientific notation with a small exponent, or a simple fraction.'); }
    const expected = parseNumeric(rule.expected), distance = absoluteDifference(value, expected);
    const absolute = configurationNumber(rule.absoluteTolerance), relative = multiply(absoluteDifference(expected, { numerator: 0n, denominator: 1n }), configurationNumber(rule.relativeTolerance));
    const tolerance = compareRational(absolute, relative) >= 0 ? absolute : relative;
    const correct = rule.exact ? equalRational(value, expected) : compareRational(distance, tolerance) <= 0;
    return decision(correct ? 'correct' : 'incorrect', correct ? 'The value and unit match the expected result.' : 'The value does not match the expected result. Check the relationship, arithmetic and unit conversion.', { normalizedAnswer: `${printRational(value)}${rule.canonicalUnit ? ` ${rule.canonicalUnit}` : ''}` });
  }
  if (rule.type === 'labels') {
    check(answer.kind === 'diagram-label', 'INVALID_ANSWER', 'Label the diagram targets for this question.');
    check(Object.keys(answer.labels).every(id => rule.targets.some(target => target.targetId === id)), 'INVALID_ANSWER', 'Only the displayed targets can be labeled.');
    const matching = rule.targets.filter(target => target.acceptedLabels.some(label => normalizeText(label) === normalizeText(answer.labels[target.targetId] ?? ''))).length;
    return decision(matching === rule.targets.length ? 'correct' : matching ? 'partial' : 'incorrect', `${matching} of ${rule.targets.length} target labels match. Use the explanation to compare their roles.`);
  }
  check(answer.kind === 'text', 'INVALID_ANSWER', 'Type or speak an explanation for this question.');
  const normalized = normalizeText(answer.text);
  if (rule.rubric.acceptedAnswers.some(item => normalizeText(item) === normalized)) return decision('correct', 'This complete answer matches the stored reference example and covers its stated rubric.', { method: 'reference-exact', reasoning: 'clear', criteria: rule.rubric.criteria.map(item => ({ criterionId: item.id, judgment: 'met' })), normalizedAnswer: normalized.slice(0, 1000) });
  if (rule.rubric.contradictions.some(item => normalizeText(item) === normalized)) return decision('incorrect', 'This answer matches a specific misconception in the stored rubric. Compare the reference explanation.', { method: 'reference-exact', reasoning: 'missing', criteria: rule.rubric.criteria.map(item => ({ criterionId: item.id, judgment: 'not-met' })) });
  return undefined;
}

async function gradeRubric(definition: AssessmentDefinition, answer: Extract<AssessmentAnswer, { kind: 'text' }>, grader?: RubricGrader, signal?: AbortSignal): Promise<GradingDecision> {
  check(definition.grading.type === 'rubric', 'INVALID_RUBRIC', 'An explanation rubric is required.');
  if (!grader) return uncertain('Your answer has been saved, but a reliable rubric evaluation is unavailable. Compare the reference explanation; this attempt does not count as an independent success.');
  try {
    signal?.throwIfAborted();
    const rubric = definition.grading.rubric;
    const result = RubricJudgmentSchema.parse(await grader({ assessment: projectAssessment(definition), rubric: immutable(rubric), answer: answer.text, sourceRefs: immutable(definition.sourceRefs), signal }));
    signal?.throwIfAborted();
    const allowed = rubric.criteria.map(item => item.id);
    check(result.criteria.length === allowed.length && unique(result.criteria.map(item => item.criterionId)).length === allowed.length && result.criteria.every(item => allowed.includes(item.criterionId)), 'INVALID_RUBRIC', 'The evaluation did not cover the exact rubric.');
    check(result.misconceptionIds.every(id => rubric.criteria.some(item => item.misconceptionId === id)), 'INVALID_RUBRIC', 'The evaluation invented a misconception reference.');
    for (const criterion of result.criteria) if (criterion.judgment === 'met' || criterion.judgment === 'partial') check(criterion.evidenceQuote?.trim() && normalizeText(answer.text).includes(normalizeText(criterion.evidenceQuote)), 'INVALID_RUBRIC', 'Supporting evidence must appear in the submitted answer.');
    const required = result.criteria.filter(item => rubric.criteria.find(criterion => criterion.id === item.criterionId)!.required);
    check(required.length > 0, 'INVALID_RUBRIC', 'At least one rubric criterion must be required.');
    const derived = required.some(item => item.judgment === 'uncertain') ? 'uncertain' : required.every(item => item.judgment === 'met') ? 'correct' : required.some(item => item.judgment === 'met' || item.judgment === 'partial') ? 'partial' : 'incorrect';
    if (result.confidence === 'low' || derived !== result.correctness || result.reasoning === 'uncertain') return uncertain('The rubric evaluation was uncertain or inconsistent. Your answer is preserved for review, without a mastery claim.');
    return { ...result, method: 'rubric' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return uncertain('The rubric evaluation could not be verified. Your answer is preserved; compare the reference or retry when evaluation is available.');
  }
}

function evidenceFor(definition: AssessmentDefinition, attempt: AssessmentAttempt, evaluation: AssessmentEvaluation): MasteryEvidence[] {
  const outcome = evaluation.correctness === 'correct' ? attempt.assisted ? 'assisted-correct' : 'independent-correct' : evaluation.correctness;
  return definition.conceptIds.map((conceptId, index) => MasteryEvidenceSchema.parse({ id: `${evaluation.id}:${index}`, packId: definition.packId, conceptId, attemptId: attempt.attemptId, assessmentId: definition.id, assessmentVersion: definition.version, evaluationId: evaluation.id, outcome, observedAt: evaluation.evaluatedAt, sourceRefs: definition.sourceRefs }));
}
export async function evaluateAttempt(input: AssessmentDefinition, rawPresentation: AssessmentPresentation, rawSubmission: SubmitAssessment, options: { sessionId: string; evaluationId: string; now: string; rubricGrader?: RubricGrader; signal?: AbortSignal }): Promise<{ attempt: AssessmentAttempt; evaluation: AssessmentEvaluation; evidence: MasteryEvidence[] }> {
  const definition = AssessmentDefinitionSchema.parse(input), presentation = AssessmentPresentationSchema.parse(rawPresentation), submission = SubmitAssessmentSchema.parse(rawSubmission);
  validatePresentation(definition, presentation, options.now);
  check(submission.presentationId === presentation.id && submission.assessmentId === definition.id && submission.assessmentVersion === definition.version, 'VERSION_CONFLICT', 'Submit the exact version and presentation that you were shown.');
  check(submission.retryOf !== submission.attemptId, 'INVALID_ATTEMPT', 'A retry needs a new attempt ID.');
  const attempt = AssessmentAttemptSchema.parse({ ...submission, sessionId: options.sessionId, packId: definition.packId, submittedAt: options.now, assistanceEventIds: presentation.assistance.map(item => item.id), assisted: presentation.assistance.length > 0, answerRevealed: presentation.assistance.some(item => item.kind === 'answer-reveal') });
  const result = gradeDeterministic(definition, attempt.answer) ?? await gradeRubric(definition, attempt.answer as Extract<AssessmentAnswer, { kind: 'text' }>, options.rubricGrader, options.signal);
  const evaluation = AssessmentEvaluationSchema.parse({ ...result, id: options.evaluationId, attemptId: attempt.attemptId, assessmentId: definition.id, assessmentVersion: definition.version, revision: 1, evaluatedAt: options.now, algorithmVersion: 'tokai-assessment-v1', explanation: definition.explanation, sourceRefs: definition.sourceRefs });
  return immutable({ attempt, evaluation, evidence: evidenceFor(definition, attempt, evaluation) });
}

/** Append this replacement evaluation and invalidate the earlier evidence; never rewrite the attempt. */
export function reviseEvaluation(definition: AssessmentDefinition, attempt: AssessmentAttempt, previous: AssessmentEvaluation, result: GradingDecision, options: { id: string; now: string }): { evaluation: AssessmentEvaluation; evidence: MasteryEvidence[] } {
  timestamp(options.now);
  check(attempt.attemptId === previous.attemptId && definition.id === attempt.assessmentId && definition.version === attempt.assessmentVersion && options.id !== previous.id, 'VERSION_CONFLICT', 'A corrected evaluation needs the same immutable attempt and a new evaluation ID.');
  check(timestamp(options.now) >= timestamp(previous.evaluatedAt), 'INVALID_TIME', 'An evaluation correction cannot predate its original.');
  const evaluation = AssessmentEvaluationSchema.parse({ ...previous, ...result, id: options.id, revision: previous.revision + 1, evaluatedAt: options.now, supersedesEvaluationId: previous.id, method: 'adjudicated' });
  return immutable({ evaluation, evidence: evidenceFor(definition, attempt, evaluation) });
}
export function invalidateMasteryEvidence(input: MasteryEvidence[], evaluationId: string, reason: string, now: string): MasteryEvidence[] {
  timestamp(now); check(reason.trim(), 'INVALID_CORRECTION', 'Record why the evidence was invalidated.');
  return immutable(input.map(item => MasteryEvidenceSchema.parse(item.evaluationId === evaluationId && !item.invalidatedAt ? { ...item, invalidatedAt: now, invalidationReason: reason } : item)));
}
