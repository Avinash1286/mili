import { z } from './zod-runtime';
import { BoardSchema } from './scene';
export { TutorLearningActionSchema, type TutorLearningAction } from './learning-action';

const id = z.string().min(1).max(100), text = z.string().min(1).max(4000), version = z.string().min(1).max(40), instant = z.string().datetime();
const ids = z.array(id).max(24);
export const LearningTopicSchema = z.enum(['photosynthesis', 'fractions', 'solar-system', 'circuits']);
export const LearningSourceRefSchema = z.object({ sourceId: id, sourceVersion: version, title: z.string().min(1).max(200), url: z.string().url().refine(value => value.startsWith('https://'), 'Sources must use HTTPS.').optional(), section: z.string().max(160).optional(), page: z.number().int().positive().optional(), chunkId: id.optional(), snippet: z.string().max(500).optional() }).strict();
export type LearningSourceRef = z.infer<typeof LearningSourceRefSchema>;
const sources = z.array(LearningSourceRefSchema).max(12);
export const LearningObjectiveSchema = z.object({ id, text, conceptIds: ids }).strict();
export const LearningConceptSchema = z.object({ id, label: z.string().min(1).max(100), explanation: text, sourceRefs: sources }).strict();
export type LearningConcept = z.infer<typeof LearningConceptSchema>;
export type LearningObjective = z.infer<typeof LearningObjectiveSchema>;
export const LearningMisconceptionSchema = z.object({ id, conceptIds: ids, claim: text, correction: text, sourceRefs: sources }).strict();
export type LearningMisconception = z.infer<typeof LearningMisconceptionSchema>;
export const AssessmentKindSchema = z.enum(['multiple-choice', 'short-answer', 'spoken-explanation', 'diagram-label', 'numeric']);
export const RubricCriterionSchema = z.object({ id, description: z.string().min(1).max(500), expected: z.string().min(1).max(800), required: z.boolean(), misconceptionId: id.optional() }).strict();
export const ExplanationRubricSchema = z.object({ version, criteria: z.array(RubricCriterionSchema).min(1).max(8), acceptedAnswers: z.array(z.string().min(1).max(2000)).max(8), contradictions: z.array(z.string().min(1).max(500)).max(8) }).strict();
export type ExplanationRubric = z.infer<typeof ExplanationRubricSchema>;
export const NumericRuleSchema = z.object({
  type: z.literal('numeric'), expected: z.string().min(1).max(60), canonicalUnit: z.string().max(30),
  acceptedUnits: z.array(z.object({ unit: z.string().max(30), factor: z.string().min(1).max(60) }).strict()).min(1).max(16),
  absoluteTolerance: z.number().finite().min(0).max(1e9), relativeTolerance: z.number().finite().min(0).max(.25), exact: z.boolean(), unitRequired: z.boolean(),
}).strict();
export type NumericRule = z.infer<typeof NumericRuleSchema>;
export const AssessmentGradingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), correctOptionIds: z.array(id).min(1).max(6) }).strict(),
  NumericRuleSchema,
  z.object({ type: z.literal('labels'), targets: z.array(z.object({ targetId: id, acceptedLabels: z.array(z.string().min(1).max(100)).min(1).max(8) }).strict()).min(1).max(12) }).strict(),
  z.object({ type: z.literal('rubric'), rubric: ExplanationRubricSchema }).strict(),
]);
const assessmentFields = {
  id, version, packId: id, kind: AssessmentKindSchema, conceptIds: ids, objectiveIds: ids,
  prompt: text, options: z.array(z.object({ id, label: z.string().min(1).max(300) }).strict()).min(2).max(6).optional(),
  diagram: BoardSchema.optional(), responseInstructions: z.string().max(500),
};
export const AssessmentDefinitionSchema = z.object({ ...assessmentFields, hints: z.array(z.object({ id, text }).strict()).min(1).max(5), explanation: text, sourceRefs: sources, grading: AssessmentGradingSchema }).strict().superRefine((assessment, context) => {
  const expected = assessment.kind === 'multiple-choice' ? 'choice' : assessment.kind === 'numeric' ? 'numeric' : assessment.kind === 'diagram-label' ? 'labels' : 'rubric';
  if (assessment.grading.type !== expected) context.addIssue({ code: 'custom', message: 'Assessment kind and grading method must agree.' });
  if (!assessment.conceptIds.length || !assessment.objectiveIds.length) context.addIssue({ code: 'custom', message: 'Assessment needs concepts and objectives.' });
  if (assessment.grading.type === 'choice' && (!assessment.options || assessment.grading.correctOptionIds.some(id => !assessment.options!.some(option => option.id === id)))) context.addIssue({ code: 'custom', message: 'Correct answers must reference the supplied options.' });
  if (assessment.options && new Set(assessment.options.map(option => option.id)).size !== assessment.options.length) context.addIssue({ code: 'custom', message: 'Option IDs must be unique.' });
  if (assessment.grading.type === 'labels' && (!assessment.diagram || assessment.grading.targets.some(target => !assessment.diagram!.nodes.some(node => node.id === target.targetId)))) context.addIssue({ code: 'custom', message: 'Label targets must exist in the supplied diagram.' });
  if (new Set(assessment.hints.map(hint => hint.id)).size !== assessment.hints.length) context.addIssue({ code: 'custom', message: 'Hint IDs must be unique.' });
});
export type AssessmentDefinition = z.infer<typeof AssessmentDefinitionSchema>;
export const PublicAssessmentSchema = z.object({ ...assessmentFields, targetIds: z.array(id).max(12).optional(), hintCount: z.number().int().min(0).max(5) }).strict();
export type PublicAssessment = z.infer<typeof PublicAssessmentSchema>;
export const AssessmentAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), optionIds: z.array(id).min(1).max(6) }).strict(),
  z.object({ kind: z.literal('numeric'), value: z.string().trim().min(1).max(80), unit: z.string().trim().max(30) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(4000), mode: z.enum(['typed', 'spoken']), transcriptId: id.optional() }).strict(),
  z.object({ kind: z.literal('diagram-label'), labels: z.record(id, z.string().trim().min(1).max(100)).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 12, 'Provide at most twelve labels.') }).strict(),
]);
export type AssessmentAnswer = z.infer<typeof AssessmentAnswerSchema>;
/** Explicit answering intent; ordinary conversation never supplies assessment evidence. */
export const PracticeResponseSchema = z.object({ presentationId: id, answer: AssessmentAnswerSchema.optional() }).strict();
export type PracticeResponse = z.infer<typeof PracticeResponseSchema>;
export const AssistanceEventSchema = z.object({ id, kind: z.enum(['hint', 'answer-reveal', 'extra-help']), hintId: id.optional(), at: instant }).strict();
export type AssistanceEvent = z.infer<typeof AssistanceEventSchema>;
export const AssessmentPresentationSchema = z.object({ id, assessmentId: id, assessmentVersion: version, createdAt: instant, revision: z.number().int().nonnegative(), assistance: z.array(AssistanceEventSchema).max(100) }).strict();
export type AssessmentPresentation = z.infer<typeof AssessmentPresentationSchema>;
export const SubmitAssessmentSchema = z.object({ attemptId: id, presentationId: id, assessmentId: id, assessmentVersion: version, answer: AssessmentAnswerSchema, learnerConfidence: z.enum(['low', 'medium', 'high']).optional(), retryOf: id.optional() }).strict();
export type SubmitAssessment = z.infer<typeof SubmitAssessmentSchema>;
export const AssessmentAttemptSchema = SubmitAssessmentSchema.extend({ sessionId: id, packId: id, submittedAt: instant, assistanceEventIds: z.array(id).max(100), assisted: z.boolean(), answerRevealed: z.boolean() }).strict();
export type AssessmentAttempt = z.infer<typeof AssessmentAttemptSchema>;
export const CorrectnessSchema = z.enum(['correct', 'partial', 'incorrect', 'uncertain']);
export const ReasoningQualitySchema = z.enum(['clear', 'partial', 'missing', 'uncertain', 'not-assessed']);
export const GraderConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const CriterionResultSchema = z.object({ criterionId: id, judgment: z.enum(['met', 'partial', 'not-met', 'uncertain']), evidenceQuote: z.string().max(240).optional() }).strict();
export const RubricJudgmentSchema = z.object({ correctness: CorrectnessSchema, reasoning: ReasoningQualitySchema, confidence: GraderConfidenceSchema, criteria: z.array(CriterionResultSchema).min(1).max(8), feedback: z.string().min(1).max(1500), misconceptionIds: z.array(id).max(8) }).strict();
export type RubricJudgment = z.infer<typeof RubricJudgmentSchema>;
export const AssessmentEvaluationSchema = z.object({
  id, attemptId: id, assessmentId: id, assessmentVersion: version, revision: z.number().int().positive(), evaluatedAt: instant,
  correctness: CorrectnessSchema, reasoning: ReasoningQualitySchema, confidence: GraderConfidenceSchema,
  method: z.enum(['deterministic', 'reference-exact', 'rubric', 'unavailable', 'adjudicated']), algorithmVersion: version,
  criteria: z.array(CriterionResultSchema).max(8), feedback: z.string().min(1).max(2000), explanation: text, sourceRefs: sources,
  misconceptionIds: z.array(id).max(8), normalizedAnswer: z.string().max(1000).optional(), supersedesEvaluationId: id.optional(),
}).strict();
export type AssessmentEvaluation = z.infer<typeof AssessmentEvaluationSchema>;
export const TutorPracticeStateSchema = z.object({ assessment: PublicAssessmentSchema, presentation: AssessmentPresentationSchema, status: z.enum(['presented', 'answered']), turnId: z.string().min(1).max(150), beatId: id, attempt: AssessmentAttemptSchema.optional(), evaluation: AssessmentEvaluationSchema.optional() }).strict();
export type TutorPracticeState = z.infer<typeof TutorPracticeStateSchema>;
export const MasteryEvidenceSchema = z.object({ id, packId: id, conceptId: id, attemptId: id, assessmentId: id, assessmentVersion: version, evaluationId: id, outcome: z.enum(['independent-correct', 'assisted-correct', 'partial', 'incorrect', 'uncertain']), observedAt: instant, sourceRefs: sources, invalidatedAt: instant.optional(), invalidationReason: z.string().max(500).optional() }).strict();
export type MasteryEvidence = z.infer<typeof MasteryEvidenceSchema>;
export const MasteryEstimateSchema = z.object({ packId: id, conceptId: id, state: z.enum(['unknown', 'learning', 'practicing', 'demonstrated', 'needs-review']), confidence: z.enum(['insufficient', 'emerging', 'supported', 'stale']), evidenceCount: z.number().int().nonnegative(), independentSuccesses: z.number().int().nonnegative(), assistedSuccesses: z.number().int().nonnegative(), lastEvidenceAt: instant.optional(), evaluatedAt: instant, algorithmVersion: z.literal('tokai-mastery-v1'), explanation: z.string().max(600) }).strict();
export type MasteryEstimate = z.infer<typeof MasteryEstimateSchema>;
export const ReviewRatingSchema = z.enum(['again', 'hard', 'good', 'easy']);
export type ReviewRating = z.infer<typeof ReviewRatingSchema>;
export const ReviewScheduleSchema = z.object({ state: z.enum(['new', 'learning', 'review']), learningStep: z.number().int().min(0).max(1), intervalDays: z.number().int().min(0).max(365), dueAt: instant, lastReviewedAt: instant.optional(), repetitions: z.number().int().nonnegative(), lapses: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), algorithmVersion: z.literal('tokai-review-v1') }).strict();
export type ReviewSchedule = z.infer<typeof ReviewScheduleSchema>;
export const LearningCardKindSchema = z.enum(['basic', 'cloze', 'diagram-label', 'spoken-recall']);
const cardFields = { kind: LearningCardKindSchema, front: text, back: text, hint: text, explanation: text, conceptIds: ids, sourceRefs: sources, diagram: BoardSchema.optional(), targetIds: ids.optional(), cloze: z.object({ before: z.string().max(2000), answer: z.string().min(1).max(500), after: z.string().max(2000) }).strict().optional(), rubricAssessmentId: id.optional() };
export const LearningCardTemplateSchema = z.object({ id, ...cardFields }).strict().superRefine((card, context) => {
  if (!card.conceptIds.length) context.addIssue({ code: 'custom', message: 'Cards need concept references.' });
  if (card.kind === 'cloze' && !card.cloze) context.addIssue({ code: 'custom', message: 'Cloze cards need an explicit omission.' });
  if (card.kind === 'diagram-label' && (!card.diagram || !card.targetIds?.length || card.targetIds.some(id => !card.diagram!.nodes.some(node => node.id === id)))) context.addIssue({ code: 'custom', message: 'Diagram cards need valid targets.' });
  if (card.kind === 'spoken-recall' && !card.rubricAssessmentId) context.addIssue({ code: 'custom', message: 'Spoken recall needs a rubric assessment.' });
});
export type LearningCardTemplate = z.infer<typeof LearningCardTemplateSchema>;
export const LearningCardSchema = z.object({ id, templateId: id.optional(), packId: id, revision: z.number().int().positive(), ...cardFields, originSessionId: id, originTurnId: id.optional(), originKind: z.enum(['covered-concept', 'lesson-reference', 'student-edit']), status: z.enum(['active', 'discarded', 'needs-correction', 'merged']), mergedIntoId: id.optional(), createdAt: instant, updatedAt: instant, schedule: ReviewScheduleSchema }).strict().superRefine((card, context) => {
  if (!card.conceptIds.length) context.addIssue({ code: 'custom', message: 'Cards need concept references.' });
  if (card.kind === 'cloze' && !card.cloze) context.addIssue({ code: 'custom', message: 'Cloze cards need an explicit omission.' });
  if (card.kind === 'diagram-label' && (!card.diagram || !card.targetIds?.length || card.targetIds.some(id => !card.diagram!.nodes.some(node => node.id === id)))) context.addIssue({ code: 'custom', message: 'Diagram cards need valid targets.' });
  if (card.kind === 'spoken-recall' && !card.rubricAssessmentId) context.addIssue({ code: 'custom', message: 'Spoken recall needs a rubric assessment.' });
  if (card.status === 'merged' && (!card.mergedIntoId || card.mergedIntoId === card.id)) context.addIssue({ code: 'custom', message: 'Merged cards need a different retained card ID.' });
});
export type LearningCard = z.infer<typeof LearningCardSchema>;
export const ReviewSubmissionSchema = z.object({ reviewId: id, cardId: id, cardRevision: z.number().int().positive(), expectedScheduleRevision: z.number().int().nonnegative(), rating: ReviewRatingSchema, suggestedRating: ReviewRatingSchema.optional(), attemptId: id.optional() }).strict();
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;
export const ReviewReceiptSchema = ReviewSubmissionSchema.extend({ reviewedAt: instant, overridden: z.boolean(), schedule: ReviewScheduleSchema, fingerprint: z.string().max(1000) }).strict();
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
export const LessonPackSchema = z.object({
  id, version, topicId: LearningTopicSchema, title: z.string().min(1).max(160), level: z.string().min(1).max(100),
  objectives: z.array(LearningObjectiveSchema).min(4).max(12), prerequisites: z.array(text).min(2).max(12), diagnosticPrompts: z.array(text).min(3).max(12),
  concepts: z.array(LearningConceptSchema).min(6).max(30), misconceptions: z.array(LearningMisconceptionSchema).min(3).max(20),
  workedExamples: z.array(z.object({ id, title: z.string().max(160), steps: z.array(text).min(2).max(10), conceptIds: ids, sourceRefs: sources }).strict()).min(2).max(12),
  diagrams: z.array(z.object({ id, title: z.string().max(160), board: BoardSchema, conceptIds: ids, sourceRefs: sources }).strict()).min(2).max(12),
  assessments: z.array(AssessmentDefinitionSchema).min(8).max(50), cardTemplates: z.array(LearningCardTemplateSchema).min(8).max(60), sources: sources.min(1),
  authoredBy: z.string().min(1).max(100), reviewedAt: instant, nextLessonSuggestion: text,
}).strict();
export type LessonPack = z.infer<typeof LessonPackSchema>;
export const LearningArtifactStatusSchema = z.enum(['not-requested', 'queued', 'running', 'ready', 'failed']);
export const StudyPackSchema = z.object({
  id, version: z.number().int().positive(), sessionId: id, title: z.string().max(200), topicId: z.string().min(1).max(160), generatedAt: instant,
  sessionRevision: z.number().int().nonnegative(), boardRevision: z.number().int().nonnegative(), packId: id.optional(), packVersion: version.optional(),
  objectives: z.array(LearningObjectiveSchema).max(32), referenceConcepts: z.array(LearningConceptSchema).max(120),
  completedNarration: z.array(z.object({ beatId: id, text, conceptIds: ids, playedMs: z.number().positive() }).strict()).max(200),
  partialNarration: z.array(z.object({ beatId: id, conceptIds: ids, playedMs: z.number().positive() }).strict()).max(200),
  attempts: z.array(z.object({ attempt: AssessmentAttemptSchema, evaluation: AssessmentEvaluationSchema }).strict()),
  mastery: z.array(MasteryEstimateSchema), unresolvedQuestions: z.array(z.string().min(1).max(2000)).max(30), notes: z.string().max(20000), cards: z.array(LearningCardSchema),
  recommendations: z.array(text).max(20), nextLessonSuggestion: text, board: BoardSchema, sourceRefs: z.array(LearningSourceRefSchema).max(120),
  recap: z.object({ text: z.string().max(4000), status: LearningArtifactStatusSchema, completedBeatIds: z.array(id).max(200) }).strict(),
}).strict();
export type StudyPack = z.infer<typeof StudyPackSchema>;
