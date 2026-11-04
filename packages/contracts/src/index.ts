import { z } from './zod-runtime';
import { PracticeResponseSchema, TutorPracticeStateSchema } from './learning';
import { SessionSettingsSchema, LessonPlanSchema, CitationSchema } from './product';
export * from './product';
export * from './learning';
import { SpatialSelectionSchema } from './spatial';
import { BoardSchema, SelectionContextSchema, ConceptMapSchema, TeachingBeatSchema, LessonFocusSchema } from './scene';
export * from './scene';
export * from './spatial';

export const TopicSchema = z.enum(['photosynthesis', 'fractions', 'solar-system', 'circuits']);
export type Topic = z.infer<typeof TopicSchema>;
export const LessonModeSchema = z.enum(['sample', 'live']);
export const MessageSchema = z.object({ id: z.string(), role: z.enum(['student', 'tutor']), text: z.string().max(12000), createdAt: z.string().datetime(), turnId: z.string().max(150).optional(), delivery: z.enum(['generated', 'playing', 'completed', 'interrupted', 'failed']).optional(), playedMs: z.number().nonnegative().optional() });
export const ConceptSchema = z.object({ id: z.string(), label: z.string(), status: z.enum(['introduced', 'practicing', 'needs-help', 'understood']) });
export const FlashcardSchema = z.object({ id: z.string(), front: z.string(), back: z.string(), conceptId: z.string() });
export const SessionSchema = z.object({
  id: z.string(), topic: z.string().min(1).max(160), title: z.string(), mode: LessonModeSchema,
  status: z.enum(['active', 'ended']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  revision: z.number().int().nonnegative(), messages: z.array(MessageSchema), board: BoardSchema,
  concepts: z.array(ConceptSchema), flashcards: z.array(FlashcardSchema), summary: z.string().optional(),
  practice: z.lazy(() => TutorPracticeStateSchema).optional(),
  settings: SessionSettingsSchema.optional(), plan: LessonPlanSchema.optional(), citations: z.array(CitationSchema).max(80).optional(), archived: z.boolean().optional(), notes: z.string().max(20000).optional(),
  visualSurface: z.enum(['board','spatial']).optional(), spatialState: SpatialSelectionSchema.optional(), conceptMap: ConceptMapSchema.optional(), teachingBeats: z.array(TeachingBeatSchema).max(200).optional(), lessonFocus: LessonFocusSchema.optional(),
  boardOperations: z.array(z.object({ operationId: z.string().max(100), hash: z.string().max(128), revision: z.number().int().nonnegative() })).max(100).optional()
});
export type Session = z.infer<typeof SessionSchema>;
export const CreateSessionSchema = z.object({ topic: TopicSchema, mode: LessonModeSchema.default('sample') });
export const SendMessageSchema = z.object({ text: z.string().trim().min(1).max(2000), requestId: z.string().min(1).max(100).optional(), selectedNodeId: z.string().max(100).optional(), selection: SelectionContextSchema.optional(), practiceResponse: z.lazy(() => PracticeResponseSchema).optional() });
export const UpdateBoardSchema = z.object({ board: BoardSchema, revision: z.number().int().nonnegative() });
export const SpeechRequestSchema = z.object({ messageId: z.string().min(1).max(100) });
export const GuestResponseSchema = z.object({ token: z.string(), expiresAt: z.string().datetime() });
export type GuestResponse = z.infer<typeof GuestResponseSchema>;
export const CapabilitiesSchema = z.object({ tutor: z.boolean(), speech: z.boolean(), voice: z.boolean().default(false) });
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const ErrorResponseSchema = z.object({ code: z.string(), message: z.string(), requestId: z.string().optional(), retryable: z.boolean().optional() });
export type ApiError = z.infer<typeof ErrorResponseSchema>;

export * from './voice';
export * from './usage';

export const TOPICS: { id: Topic; title: string; subject: string; description: string; duration: string }[] = [
  { id: 'photosynthesis', title: 'How plants make their food', subject: 'Biology', description: 'Follow sunlight from a leaf to a little packet of energy.', duration: '12 min' },
  { id: 'fractions', title: 'A whole new way to see fractions', subject: 'Mathematics', description: 'Turn parts of a whole into something that clicks.', duration: '10 min' },
  { id: 'solar-system', title: 'Our neighborhood in space', subject: 'Astronomy', description: 'Explore the planets and the force that keeps them together.', duration: '15 min' },
  { id: 'circuits', title: 'Let’s make a light turn on', subject: 'Physics', description: 'Trace the invisible journey of an electric current.', duration: '12 min' }
];

export * from './http';
export * from './course';
export * from './course-engine';

export * from './dictation-stream';
