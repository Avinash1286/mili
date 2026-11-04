import { z } from './zod-runtime';

const id = z.string().min(1).max(100), instant = z.string().datetime();
export const SpeechLanguageSchema = z.enum(['english', 'spanish', 'german', 'french', 'italian', 'portuguese']);
export type SpeechLanguage = z.infer<typeof SpeechLanguageSchema>;
const VOICE_IDS = ['aai-audrey', 'aai-kyla', 'aai-sara', 'aai-peter', 'aai-titus', 'aai-nancy', 'aai-troy', 'aai-jane', 'aai-michael', 'aai-constanza', 'aai-magdalena', 'aai-donatien', 'aai-benicio'] as const;
export const TutorVoiceSchema = z.enum(VOICE_IDS);
export type TutorVoice = (typeof VOICE_IDS)[number];
/** Curated AssemblyAI voices; each speaks best in its recorded language. */
export const TUTOR_VOICES: { id: TutorVoice; name: string; description: string; language: z.infer<typeof SpeechLanguageSchema> }[] = [
  { id: 'aai-audrey', name: 'Audrey', description: 'Calm and steady', language: 'english' },
  { id: 'aai-kyla', name: 'Kyla', description: 'Bright and quick', language: 'english' },
  { id: 'aai-sara', name: 'Sara', description: 'Warm and even', language: 'english' },
  { id: 'aai-peter', name: 'Peter', description: 'Soft-spoken', language: 'english' },
  { id: 'aai-titus', name: 'Titus', description: 'Deep and relaxed', language: 'english' },
  { id: 'aai-nancy', name: 'Nancy', description: 'British, even tone', language: 'english' },
  { id: 'aai-troy', name: 'Troy', description: 'Scottish, gentle', language: 'english' },
  { id: 'aai-jane', name: 'Jane', description: 'Clear and neutral', language: 'english' },
  { id: 'aai-michael', name: 'Michael', description: 'Friendly and clear', language: 'english' },
  { id: 'aai-constanza', name: 'Constanza', description: 'Mexican Spanish', language: 'spanish' },
  { id: 'aai-magdalena', name: 'Magdalena', description: 'German', language: 'german' },
  { id: 'aai-donatien', name: 'Donatien', description: 'French', language: 'french' },
  { id: 'aai-benicio', name: 'Benício', description: 'Portuguese', language: 'portuguese' },
];
export const LearnerPreferencesSchema = z.object({
  displayName: z.string().trim().max(80).default(''), level: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  goal: z.string().trim().max(500).default(''), lessonMinutes: z.number().int().min(5).max(60).default(15),
  language: SpeechLanguageSchema.default('english'), voiceId: TutorVoiceSchema.default('aai-audrey'),
  explanationStyle: z.enum(['concise', 'step-by-step', 'slower']).default('step-by-step'),
  timezone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).default('UTC'),
  reducedMotion: z.boolean().default(false), highContrast: z.boolean().default(false), fontScale: z.enum(['normal', 'large']).default('normal'),
  retainTranscript: z.boolean().default(true), retainRecapAudio: z.boolean().default(false), retentionDays: z.number().int().min(1).max(365).default(30),
}).strict();
export type LearnerPreferences = z.infer<typeof LearnerPreferencesSchema>;
export const LessonPlanSchema = z.object({ version: z.literal(1), goal: z.string().max(500), level: z.string().max(80), minutes: z.number().int().min(5).max(60),
  objectives: z.array(z.string().min(1).max(300)).min(1).max(8), prerequisites: z.array(z.string().max(300)).max(8),
  steps: z.array(z.object({ title: z.string().max(120), objective: z.string().max(500) }).strict()).min(1).max(8),
  provenance: z.enum(['authored', 'generated', 'learner-goal']), status: z.enum(['ready', 'pending', 'failed']),
}).strict();
export type LessonPlan = z.infer<typeof LessonPlanSchema>;
export const CitationSchema = z.object({ id, sourceId: id, sourceVersion: z.number().int().nonnegative(), title: z.string().max(200), page: z.number().int().positive().optional(), section: z.string().max(160).optional(), snippet: z.string().max(1200), chunkId: id }).strict();
export type Citation = z.infer<typeof CitationSchema>;
export const SourceSchema = z.object({ id, title: z.string().max(200), filename: z.string().max(200), mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']), bytes: z.number().int().positive().max(10 * 1024 * 1024),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative(), status: z.enum(['awaiting-upload', 'queued', 'processing', 'ready', 'failed']),
  createdAt: instant, updatedAt: instant, pages: z.number().int().nonnegative().optional(), chunks: z.number().int().nonnegative().optional(), error: z.string().max(500).optional(),
  parserVersion: z.string().max(100).optional(), embeddingModel: z.string().max(120).optional(), fileExpiresAt: instant.optional(),
}).strict();
export type Source = z.infer<typeof SourceSchema>;
export const UploadIntentSchema = SourceSchema.pick({ title: true, filename: true, mimeType: true, bytes: true, checksum: true });
export const ArtifactSchema = z.object({ id, sessionId: id, kind: z.enum(['study-pack', 'recap', 'export', 'cards', 'assessment']), format: z.enum(['markdown', 'pdf', 'csv', 'json', 'wav']).optional(),
  status: z.enum(['queued', 'running', 'ready', 'failed']), revision: z.number().int().nonnegative(), createdAt: instant, updatedAt: instant, error: z.string().max(500).optional(),
  durationMs: z.number().nonnegative().optional(), fileExpiresAt: instant.optional(), captions: z.array(z.object({ text: z.string().max(200), startMs: z.number().nonnegative(), endMs: z.number().nonnegative() }).strict()).max(1500).optional(),
}).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export const SessionSettingsSchema = z.object({ preferences: LearnerPreferencesSchema, goal: z.string().trim().max(500), sourceIds: z.array(id).max(8), grounding: z.enum(['general', 'sources-only']) }).strict();
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;
export const CreateLessonSchema = z.object({ topic: z.string().trim().min(2).max(160), mode: z.enum(['sample', 'live']).default('live'), goal: z.string().trim().max(500).default(''), sourceIds: z.array(id).max(8).default([]), grounding: z.enum(['general', 'sources-only']).default('general'), preferences: LearnerPreferencesSchema.optional() }).strict();
export type CreateLesson = z.infer<typeof CreateLessonSchema>;
export const ShareLinkSchema = z.object({ id, sessionId: id, createdAt: instant, expiresAt: instant, revoked: z.boolean(), includeNotes: z.boolean(), includeCards: z.boolean() }).strict();
export type ShareLink = z.infer<typeof ShareLinkSchema>;
export const IdentitySchema = z.object({ kind: z.enum(['anonymous', 'guest', 'user']), displayName: z.string().max(80).optional(), expiresAt: instant.optional(), signInAvailable: z.boolean() });
export type Identity = z.infer<typeof IdentitySchema>;
export const NoteUpdateSchema = z.object({ notes: z.string().max(20000), revision: z.number().int().nonnegative() }).strict();
export const SessionEditSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional() }).strict();
