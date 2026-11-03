import { z } from 'zod';

export const TopicSchema = z.enum(['photosynthesis', 'fractions', 'solar-system', 'circuits']);
export type Topic = z.infer<typeof TopicSchema>;
export const LessonModeSchema = z.enum(['sample', 'live']);
export const BoardNodeSchema = z.object({
  id: z.string().min(1).max(100), label: z.string().min(1).max(120),
  detail: z.string().max(1000), x: z.number().finite().min(-5000).max(5000),
  y: z.number().finite().min(-5000).max(5000), kind: z.enum(['root', 'concept', 'detail', 'question'])
});
export const BoardEdgeSchema = z.object({ id: z.string().min(1).max(100), from: z.string(), to: z.string(), label: z.string().max(80).optional() });
export const BoardSchema = z.object({ nodes: z.array(BoardNodeSchema).max(40), edges: z.array(BoardEdgeSchema).max(80) }).superRefine((board, ctx) => {
  const nodes = new Set(board.nodes.map(n => n.id));
  if (nodes.size !== board.nodes.length) ctx.addIssue({ code: 'custom', message: 'Board node IDs must be unique', path: ['nodes'] });
  if (new Set(board.edges.map(e => e.id)).size !== board.edges.length) ctx.addIssue({ code: 'custom', message: 'Board edge IDs must be unique', path: ['edges'] });
  for (const [i, edge] of board.edges.entries()) if (!nodes.has(edge.from) || !nodes.has(edge.to)) ctx.addIssue({ code: 'custom', message: 'Edges must reference existing nodes', path: ['edges', i] });
});
export type Board = z.infer<typeof BoardSchema>;
export type BoardNode = z.infer<typeof BoardNodeSchema>;
export const MessageSchema = z.object({ id: z.string(), role: z.enum(['student', 'tutor']), text: z.string().max(12000), createdAt: z.string().datetime(), turnId: z.string().max(150).optional(), delivery: z.enum(['generated', 'playing', 'completed', 'interrupted', 'failed']).optional(), playedMs: z.number().nonnegative().optional() });
export const ConceptSchema = z.object({ id: z.string(), label: z.string(), status: z.enum(['introduced', 'practicing', 'needs-help', 'understood']) });
export const FlashcardSchema = z.object({ id: z.string(), front: z.string(), back: z.string(), conceptId: z.string() });
export const SessionSchema = z.object({
  id: z.string(), topic: TopicSchema, title: z.string(), mode: LessonModeSchema,
  status: z.enum(['active', 'ended']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  revision: z.number().int().nonnegative(), messages: z.array(MessageSchema), board: BoardSchema,
  concepts: z.array(ConceptSchema), flashcards: z.array(FlashcardSchema), summary: z.string().optional()
});
export type Session = z.infer<typeof SessionSchema>;
export const CreateSessionSchema = z.object({ topic: TopicSchema, mode: LessonModeSchema.default('sample') });
export const SendMessageSchema = z.object({ text: z.string().trim().min(1).max(2000), selectedNodeId: z.string().max(100).optional() });
export const UpdateBoardSchema = z.object({ board: BoardSchema, revision: z.number().int().nonnegative() });
export const SpeechRequestSchema = z.object({ messageId: z.string().min(1).max(100) });
export const GuestResponseSchema = z.object({ token: z.string(), expiresAt: z.string().datetime() });
export type GuestResponse = z.infer<typeof GuestResponseSchema>;
export const CapabilitiesSchema = z.object({ tutor: z.boolean(), speech: z.boolean(), voice: z.boolean().default(false) });
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const ErrorResponseSchema = z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() });
export type ApiError = z.infer<typeof ErrorResponseSchema>;

export * from './voice';

export const TOPICS: { id: Topic; title: string; subject: string; description: string; duration: string }[] = [
  { id: 'photosynthesis', title: 'How plants make their food', subject: 'Biology', description: 'Follow sunlight from a leaf to a little packet of energy.', duration: '12 min' },
  { id: 'fractions', title: 'A whole new way to see fractions', subject: 'Mathematics', description: 'Turn parts of a whole into something that clicks.', duration: '10 min' },
  { id: 'solar-system', title: 'Our neighborhood in space', subject: 'Astronomy', description: 'Explore the planets and the force that keeps them together.', duration: '15 min' },
  { id: 'circuits', title: 'Let’s make a light turn on', subject: 'Physics', description: 'Trace the invisible journey of an electric current.', duration: '12 min' }
];
