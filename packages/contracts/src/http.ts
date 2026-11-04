import { z } from './zod-runtime';
import { LearnerPreferencesSchema } from './product';
import { LearningCardSchema } from './learning';

// These schemas are used by the HTTP handlers and the generated OpenAPI contract.
export const PreferencesUpdateSchema = z.object({ preferences: LearnerPreferencesSchema, revision: z.number().int().min(-1) }).strict();
export const PrivacyUpdateSchema = z.object({ revision: z.number().int().nonnegative(), retainTranscript: z.boolean().optional(), retainRecapAudio: z.boolean().optional(), retentionDays: z.number().int().min(1).max(365).optional() }).strict();
export const AssessmentRequestSchema = z.object({ assessmentId: z.string().min(1).max(100) }).strict();
export const AssistanceRequestSchema = z.object({ hintId: z.string().max(100).optional() }).strict();
export const AppealRequestSchema = z.object({ reason: z.string().trim().min(3).max(2000) }).strict();
export const CardUpdateSchema = z.object({ revision: z.number().int().positive(), front: z.string().min(1).max(1000).optional(), back: z.string().min(1).max(3000).optional(), hint: z.string().max(1000).optional(), explanation: z.string().max(3000).optional(), cloze: LearningCardSchema.shape.cloze.optional(), status: z.enum(['active', 'discarded', 'needs-correction']).optional() }).strict();
export const CardMergeSchema = z.object({ targetId: z.string().min(1).max(100) }).strict();
export const RecallAnswerSchema = z.object({ text: z.string().trim().min(1).max(3000), mode: z.enum(['typed', 'spoken']) }).strict();
export const ArtifactRequestSchema = z.object({ kind: z.enum(['study-pack', 'recap', 'cards', 'export']), format: z.enum(['markdown', 'pdf', 'csv', 'json']).optional() }).strict();
export const ShareRequestSchema = z.object({ sessionId: z.string().min(1).max(100), expiresInDays: z.number().int().min(1).max(30), includeNotes: z.boolean(), includeCards: z.boolean() }).strict();
export const NativeSessionRequestSchema = z.object({ token: z.string().min(20).max(20000) }).strict();
export const DictationRequestSchema = z.object({ pcm: z.string().min(4).max(1280000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), sampleRate: z.literal(16000) }).strict();
export const JobExecutionSchema = z.object({ jobId: z.string().min(1).max(100), workerId: z.string().min(1).max(100), fence: z.number().int().positive() }).strict();
