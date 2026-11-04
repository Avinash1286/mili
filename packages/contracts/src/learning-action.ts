import { z } from './zod-runtime';

// Keep teaching action identifiers independent of board/assessment schemas.
const id = z.string().min(1).max(100), version = z.string().min(1).max(40);
export const TutorLearningActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ask_question'), assessmentId: id, assessmentVersion: version }).strict(),
  z.object({ type: z.literal('evaluate_answer'), presentationId: id }).strict(),
  z.object({ type: z.literal('generate_flashcards') }).strict(),
]);
export type TutorLearningAction = z.infer<typeof TutorLearningActionSchema>;
