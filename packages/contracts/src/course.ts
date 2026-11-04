import { z } from './zod-runtime';
import { LearnerPreferencesSchema } from './product';

/**
 * Step-by-step interactive courses & Adaptive Agentic Tutor contracts:
 * - Curriculum syllabus is planned upfront; Concept 1 is generated immediately so the session starts without waiting.
 * - Remaining chapters prepare asynchronously in the background (`status: 'pending' -> 'ready'`).
 * - Each step separates Concept Teaching (`teach` stage, spoken first) from Question Practice (`practice` stage).
 * - The Agentic Turn Loop handles answers, misconceptions, remedial micro-steps, spoken answers, and off-script learner questions
 *   while always bridging back to complete the prepared syllabus.
 */
const cid = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Use short lowercase IDs.');
const short = (max: number) => z.string().trim().min(1).max(max);
const num = z.number().finite().min(-1e6).max(1e6);
export const CoursePaletteSchema = z.enum(['green', 'blue', 'orange', 'purple', 'red', 'gray', 'yellow', 'teal']);
export type CoursePalette = z.infer<typeof CoursePaletteSchema>;
const color = CoursePaletteSchema.optional();
const axis = z.object({ min: num, max: num, step: z.number().finite().positive().max(1e5) }).strict().refine(value => value.max > value.min && (value.max - value.min) / value.step <= 60, 'Axis range must be increasing with at most 60 grid steps.');
const ParamNameSchema = z.string().regex(/^[a-df-wyzA-Z]$/, 'Parameters are single letters other than x and e.');

export const PlotVisualSchema = z.object({
  kind: z.literal('plot'), id: cid, alt: short(400), title: z.string().max(80).optional(), xLabel: z.string().max(60).optional(), yLabel: z.string().max(60).optional(),
  x: axis, y: axis,
  functions: z.array(z.object({ id: cid, expr: short(160), color, label: z.string().max(40).optional(), dashed: z.boolean().optional(), domain: z.tuple([num, num]).optional() }).strict()).max(4).default([]),
  points: z.array(z.object({ id: cid, x: num, y: num, label: z.string().max(30).optional(), color }).strict()).max(16).default([]),
  params: z.array(z.object({ name: ParamNameSchema, label: short(40), min: num, max: num, step: z.number().finite().positive(), value: num }).strict()).max(3).default([]),
}).strict();
export const NumberLineVisualSchema = z.object({
  kind: z.literal('number-line'), id: cid, alt: short(400), min: num, max: num, step: z.number().finite().positive(),
  marks: z.array(z.object({ id: cid, value: num, label: z.string().max(20).optional(), color }).strict()).max(12).default([]),
  range: z.object({ from: num, to: num, color }).strict().optional(),
}).strict();
export const FractionVisualSchema = z.object({
  kind: z.literal('fraction-bars'), id: cid, alt: short(400),
  bars: z.array(z.object({ id: cid, parts: z.number().int().min(1).max(24), shaded: z.number().int().min(0).max(24), label: z.string().max(30).optional(), color }).strict()).min(1).max(4),
}).strict();
export const FlowVisualSchema = z.object({
  kind: z.literal('flow'), id: cid, alt: short(400), layout: z.enum(['row', 'column', 'cycle']).default('row'),
  nodes: z.array(z.object({ id: cid, label: short(40), emoji: z.string().max(8).optional(), detail: z.string().max(80).optional(), color }).strict()).min(2).max(6),
  links: z.array(z.object({ from: cid, to: cid, label: z.string().max(30).optional() }).strict()).max(8).default([]),
}).strict();
export const BarsVisualSchema = z.object({
  kind: z.literal('bars'), id: cid, alt: short(400), unit: z.string().max(16).optional(),
  bars: z.array(z.object({ id: cid, label: short(24), value: z.number().finite().min(0).max(1e9), color }).strict()).min(1).max(8),
}).strict();
const shapeBase = { id: cid, fill: color, label: z.string().max(40).optional(), step: z.number().int().min(0).max(8).optional() };
const coordinate = z.number().finite().min(-50).max(450);
export const ShapeElementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('circle'), ...shapeBase, cx: coordinate, cy: coordinate, r: z.number().finite().positive().max(200) }).strict(),
  z.object({ type: z.literal('rect'), ...shapeBase, x: coordinate, y: coordinate, w: z.number().finite().positive().max(400), h: z.number().finite().positive().max(240), rounded: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('line'), ...shapeBase, x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate, arrow: z.boolean().optional(), dashed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('text'), ...shapeBase, x: coordinate, y: coordinate, text: short(60), size: z.enum(['s', 'm', 'l']).optional() }).strict(),
  z.object({ type: z.literal('polygon'), ...shapeBase, points: z.array(z.tuple([coordinate, coordinate])).min(3).max(12) }).strict(),
]);
export type ShapeElement = z.infer<typeof ShapeElementSchema>;
export const ShapesVisualSchema = z.object({ kind: z.literal('shapes'), id: cid, alt: short(400), elements: z.array(ShapeElementSchema).min(1).max(30) }).strict();
export const TableVisualSchema = z.object({ kind: z.literal('table'), id: cid, alt: short(400), headers: z.array(short(30)).min(1).max(5), rows: z.array(z.array(z.string().max(40)).min(1).max(5)).min(1).max(8) }).strict();
export const CalloutVisualSchema = z.object({ kind: z.literal('callout'), id: cid, alt: short(400), emoji: short(12), caption: z.string().max(80).optional() }).strict();
export const CourseVisualSchema = z.discriminatedUnion('kind', [PlotVisualSchema, NumberLineVisualSchema, FractionVisualSchema, FlowVisualSchema, BarsVisualSchema, ShapesVisualSchema, TableVisualSchema, CalloutVisualSchema]);
export type CourseVisual = z.infer<typeof CourseVisualSchema>;
export type PlotVisual = z.infer<typeof PlotVisualSchema>;

const option = z.object({ id: cid, text: short(140) }).strict();
export const CourseInteractionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcq'), options: z.array(option).min(2).max(6), correct: z.array(cid).min(1).max(6), multiple: z.boolean().default(false), feedback: z.array(z.object({ optionId: cid, text: short(240) }).strict()).max(6).default([]) }).strict(),
  z.object({ type: z.literal('true-false'), statement: z.string().max(240).optional(), answer: z.boolean() }).strict(),
  z.object({ type: z.literal('fill-tiles'), template: short(300), tiles: z.array(option).min(2).max(10), slots: z.array(z.object({ id: cid, accept: z.array(cid).min(1).max(6) }).strict()).min(1).max(6) }).strict(),
  z.object({ type: z.literal('fill-input'), template: short(300), slots: z.array(z.object({ id: cid, accept: z.array(short(60)).min(1).max(8), numeric: z.object({ value: num, tolerance: z.number().finite().min(0).max(1e5) }).strict().optional() }).strict()).min(1).max(4) }).strict(),
  z.object({ type: z.literal('order'), prompt: z.string().max(120).optional(), items: z.array(option).min(3).max(6) }).strict(),
  z.object({ type: z.literal('match'), leftLabel: z.string().max(30).optional(), rightLabel: z.string().max(30).optional(), pairs: z.array(z.object({ id: cid, left: short(80), right: short(80) }).strict()).min(2).max(5) }).strict(),
  z.object({ type: z.literal('categorize'), buckets: z.array(z.object({ id: cid, label: short(40) }).strict()).min(2).max(3), items: z.array(z.object({ id: cid, text: short(60), bucket: cid }).strict()).min(3).max(8) }).strict(),
  z.object({ type: z.literal('mark-points'), targets: z.array(z.object({ x: num, y: num }).strict()).min(1).max(4), tolerance: z.number().finite().min(0).max(1e4).default(0) }).strict(),
  z.object({ type: z.literal('slider'), label: short(60), min: num, max: num, step: z.number().finite().positive(), initial: num, unit: z.string().max(12).optional(), bindParam: ParamNameSchema.optional(), accept: z.object({ min: num, max: num }).strict() }).strict(),
]);
export type CourseInteraction = z.infer<typeof CourseInteractionSchema>;
export type CourseInteractionType = CourseInteraction['type'];

export const CourseStepSchema = z.object({
  id: cid, kind: z.enum(['concept', 'question']), title: z.string().max(80).optional(),
  body: short(700),
  /** Optional explicit concept teaching prose shown & spoken BEFORE the question is revealed. */
  conceptBody: z.string().max(650).optional(),
  /** Natural spoken explanation read aloud by milli during the `teach` stage. */
  conceptSpeech: z.string().max(650).optional(),
  /** Visual element IDs to pulse while milli explains the concept. */
  conceptHighlight: z.array(cid).max(6).optional(),
  /** Explicit question prompt spoken & shown when transitioning from `teach` to `practice`. */
  questionPrompt: z.string().max(360).optional(),
  /** A question learners can answer in their own words. */
  spokenQuestion: short(360).optional(),
  /** A tutor-controlled plot parameter change shown during the explanation. */
  demonstration: z.object({ parameter: ParamNameSchema, value: num }).strict().optional(),
  /** Step ID this remedial micro-step was dynamically generated to scaffold. */
  remedialFor: cid.optional(),
  visual: CourseVisualSchema.optional(), interaction: CourseInteractionSchema.optional(),
  hint: z.string().max(400).optional(), explanation: short(900),
}).strict();
export type CourseStep = z.infer<typeof CourseStepSchema>;

export const CourseChapterSchema = z.object({
  id: cid, title: short(80), goal: short(240),
  status: z.enum(['ready', 'pending', 'failed']),
  steps: z.array(CourseStepSchema).max(12),
}).strict();
export type CourseChapter = z.infer<typeof CourseChapterSchema>;

export const CourseScriptSchema = z.object({
  version: z.literal(1), title: short(120), topic: short(160), provenance: z.enum(['authored', 'generated']),
  summary: short(600), concepts: z.array(z.object({ id: cid, label: short(60) }).strict()).max(12).default([]),
  cards: z.array(z.object({ front: short(200), back: short(400) }).strict()).max(12).default([]),
  chapters: z.array(CourseChapterSchema).min(1).max(6),
}).strict();
export type CourseScript = z.infer<typeof CourseScriptSchema>;

export const CourseAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcq'), selected: z.array(cid).max(6) }).strict(),
  z.object({ type: z.literal('true-false'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('fill-tiles'), slots: z.record(cid, cid) }).strict(),
  z.object({ type: z.literal('fill-input'), slots: z.record(cid, z.string().max(60)) }).strict(),
  z.object({ type: z.literal('order'), order: z.array(cid).max(6) }).strict(),
  z.object({ type: z.literal('match'), pairs: z.record(cid, cid) }).strict(),
  z.object({ type: z.literal('categorize'), placement: z.record(cid, cid) }).strict(),
  z.object({ type: z.literal('mark-points'), points: z.array(z.object({ x: num, y: num }).strict()).max(8) }).strict(),
  z.object({ type: z.literal('slider'), value: num }).strict(),
]);
export type CourseAnswer = z.infer<typeof CourseAnswerSchema>;

export const StepResultSchema = z.object({ correct: z.boolean(), attempts: z.number().int().min(0).max(99), revealed: z.boolean(), xp: z.number().int().min(0).max(100) }).strict();
export const CourseHistoryEntrySchema = z.object({
  role: z.enum(['learner', 'tutor']),
  text: short(800),
  stepId: cid,
  intent: z.string().max(40).optional(),
}).strict();
export type CourseHistoryEntry = z.infer<typeof CourseHistoryEntrySchema>;

export const CourseProgressSchema = z.object({
  chapter: z.number().int().min(0).max(5),
  step: z.number().int().min(0).max(11),
  stage: z.enum(['teach', 'practice']).optional(),
  xp: z.number().int().min(0).max(100000),
  results: z.record(cid, StepResultSchema),
  history: z.array(CourseHistoryEntrySchema).max(24).optional(),
  completedAt: z.string().datetime().optional(),
}).strict();
export type CourseProgress = z.infer<typeof CourseProgressSchema>;

export const SaveCourseProgressSchema = z.object({ revision: z.number().int().min(-1), progress: CourseProgressSchema }).strict();

export const StartCourseSessionSchema = z.object({
  topic: z.string().trim().min(2).max(160),
  mode: z.enum(['sample', 'live']).default('live'),
  goal: z.string().trim().max(500).default(''),
  sourceIds: z.array(z.string().min(1).max(100)).max(8).default([]),
  grounding: z.enum(['general', 'sources-only']).default('general'),
  preferences: LearnerPreferencesSchema.optional(),
  featured: z.boolean().optional(),
}).strict();
export type StartCourseSession = z.infer<typeof StartCourseSessionSchema>;

export const PrepareChapterRequestSchema = z.object({
  chapterIndex: z.number().int().min(0).max(5).optional(),
}).strict();
export type PrepareChapterRequest = z.infer<typeof PrepareChapterRequestSchema>;

export const CourseTurnIntentSchema = z.enum([
  'affirm',
  'hint',
  'remedial',
  'side-question',
  'spoken-answer',
  'clarify',
  'advance-to-question',
]);
export type CourseTurnIntent = z.infer<typeof CourseTurnIntentSchema>;

export const CourseTurnRequestSchema = z.object({
  stepId: cid,
  event: z.enum(['check', 'learner-message', 'why', 'simpler']),
  mode: z.enum(['typed', 'spoken', 'ui']).default('ui'),
  learnerText: z.string().trim().max(800).optional(),
  answer: CourseAnswerSchema.optional(),
  answerSummary: z.string().max(400).optional(),
  correct: z.boolean().optional(),
  attempts: z.number().int().min(0).max(99).default(0),
  stage: z.enum(['teach', 'practice', 'checked']).default('practice'),
}).strict();
export type CourseTurnRequest = z.infer<typeof CourseTurnRequestSchema>;

export const CourseTurnReplySchema = z.object({
  messageId: z.string().max(100),
  intent: CourseTurnIntentSchema,
  spokenText: short(700),
  displayText: short(900),
  bridgeText: z.string().max(260).optional(),
  replies: z.array(short(44)).max(3).default([]),
  highlight: z.array(cid).max(6).default([]),
  markStepSolved: z.boolean().default(false),
  advanceToPractice: z.boolean().default(false),
  insertedStep: CourseStepSchema.optional(),
  clarifyVisual: CourseVisualSchema.optional(),
  source: z.enum(['live', 'prepared']),
}).strict();
export type CourseTurnReply = z.infer<typeof CourseTurnReplySchema>;

export const CourseHelpRequestSchema = z.object({
  stepId: cid, text: z.string().trim().min(1).max(600), mode: z.enum(['typed', 'spoken']).default('typed'),
  attempts: z.number().int().min(0).max(99).default(0), answerSummary: z.string().max(400).optional(), status: z.enum(['unanswered', 'correct', 'incorrect', 'revealed']).default('unanswered'),
}).strict();
export type CourseHelpRequest = z.infer<typeof CourseHelpRequestSchema>;
export const CourseHelpReplySchema = z.object({
  messageId: z.string().max(100), text: short(700), replies: z.array(short(40)).max(3).default([]), highlight: z.array(cid).max(6).default([]), source: z.enum(['live', 'prepared']),
}).strict();
export type CourseHelpReply = z.infer<typeof CourseHelpReplySchema>;

export const CourseSpeechRequestSchema = z.object({
  stepId: cid.optional(),
  part: z.enum(['concept', 'question', 'step', 'body', 'explanation']).default('body'),
  text: z.string().trim().max(900).optional(),
}).strict();
export type CourseSpeechRequest = z.infer<typeof CourseSpeechRequestSchema>;

export const emptyCourseProgress = (): CourseProgress => ({ chapter: 0, step: 0, stage: 'teach', xp: 0, results: {}, history: [] });
/** Estimates total steps across ready and pending chapters (pending chapters estimate 2 steps each until generated). */
export const courseStepCount = (script: CourseScript) =>
  script.chapters.reduce((total, chapter) => total + (chapter.steps.length > 0 ? chapter.steps.length : chapter.status === 'pending' ? 2 : 0), 0);
/** XP rewards a first-try answer most, never rewards a revealed answer. */
export const stepXp = (attempts: number, revealed: boolean) => revealed ? 0 : attempts <= 1 ? 15 : attempts === 2 ? 10 : 5;
