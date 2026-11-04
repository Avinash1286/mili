import { GuestResponseSchema, SessionSchema, CapabilitiesSchema, VoiceTicketSchema, IdentitySchema, LearnerPreferencesSchema, SourceSchema, UploadIntentSchema, ArtifactSchema, ShareLinkSchema, PublicAssessmentSchema, AssessmentPresentationSchema, AssessmentAttemptSchema, AssessmentEvaluationSchema, MasteryEstimateSchema, LearningCardSchema, ReviewReceiptSchema, StudyPackSchema, CreateLessonSchema,
  type Session, type Topic, type Board, type BoardTransaction, type MapUpdate, type SelectionContext, type Identity, type LearnerPreferences, type CreateLesson, type Source, type PublicAssessment, type AssessmentAttempt, type AssessmentEvaluation, type MasteryEstimate, type LearningCard, type StudyPack, type Artifact, type SubmitAssessment, type ReviewSubmission, type UsageSummary, type PracticeResponse,
} from '@tokai/contracts';
const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const KEY = 'tokai.guest.v1';
let pendingGuest: Promise<string> | undefined;
let pendingAccess: Promise<Record<string, string>> | undefined;
let credentialEpoch = 0, pendingAccessEpoch = -1, pendingAccessKey = '';
let accessCache: { epoch: number; key: string; expiresAt: number; headers: Record<string, string> } | undefined;
function invalidateAccess() { credentialEpoch++; pendingAccess = undefined; pendingGuest = undefined; accessCache = undefined; }
export type Me = { identity: Identity; preferences: LearnerPreferences; revision: number };
export type LearningState = { assessments: PublicAssessment[]; attempts: { attempt: AssessmentAttempt; evaluation: AssessmentEvaluation }[]; mastery: MasteryEstimate[]; cards: LearningCard[]; studyPack?: StudyPack; artifacts: Artifact[] };

export class RequestError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function responseData(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(data.message || data.error?.message || 'Something went wrong. Please try again.', response.status, data.code || data.error?.code);
  return data;
}
function existingGuest() {
  const saved = localStorage.getItem(KEY);
  if (saved) { try { const data = GuestResponseSchema.parse(JSON.parse(saved)); if (Date.parse(data.expiresAt) > Date.now() + 30000) return data.token; } catch {} }
  return undefined;
}
export async function guestToken(): Promise<string> {
  const saved = existingGuest(); if (saved) return saved;
  if (!pendingGuest) {
    const epoch = credentialEpoch;
    const work = (async () => { const response = await fetch(`${API}/v1/guest-sessions`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) }); const data = GuestResponseSchema.parse(await responseData(response)); if (epoch === credentialEpoch) localStorage.setItem(KEY, JSON.stringify(data)); return data.token; })().finally(() => { if (pendingGuest === work) pendingGuest = undefined; });
    pendingGuest = work;
  }
  return pendingGuest;
}
async function inspectIdentity(): Promise<Me> {
  const token = existingGuest();
  const data = await responseData(await fetch(`${API}/v1/me`, { credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store', signal: AbortSignal.timeout(10000) }));
  const identity = IdentitySchema.parse(data.identity);
  // A slower anonymous inspection must not erase a guest created by a concurrent request.
  if (token && identity.kind !== 'guest' && existingGuest() === token) localStorage.removeItem(KEY);
  return { identity, preferences: LearnerPreferencesSchema.parse(data.preferences), revision: data.revision };
}
async function accessHeaders(): Promise<Record<string, string>> {
  const epoch = credentialEpoch, key = existingGuest() ?? '';
  if (accessCache?.epoch === epoch && accessCache.key === key && accessCache.expiresAt > Date.now()) return { ...accessCache.headers };
  if (!pendingAccess || pendingAccessEpoch !== epoch || pendingAccessKey !== key) {
    const work = (async (): Promise<Record<string, string>> => {
      const me = await inspectIdentity();
      if (epoch !== credentialEpoch) return accessHeaders();
      const headers: Record<string, string> = me.identity.kind === 'user' ? {} : { Authorization: `Bearer ${await guestToken()}` };
      if (epoch !== credentialEpoch) return accessHeaders();
      accessCache = { epoch, key: existingGuest() ?? '', expiresAt: Date.now() + 2000, headers };
      return { ...headers };
    })().finally(() => { if (pendingAccess === work) pendingAccess = undefined; });
    pendingAccess = work; pendingAccessEpoch = epoch; pendingAccessKey = key;
  }
  return pendingAccess;
}
async function authenticatedFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && typeof options.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(await accessHeaders())) headers.set(key, value);
  const response = await fetch(`${API}${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(45000), headers, credentials: 'include', cache: 'no-store' });
  if (response.status === 401) { const sentToken = headers.get('Authorization')?.replace(/^Bearer /, ''); if (sentToken && existingGuest() === sentToken) localStorage.removeItem(KEY); invalidateAccess(); throw new RequestError('Your access expired. Sign in again or reload to use guest access.', 401); }
  return response;
}
async function request(path: string, options: RequestInit = {}) {
  const response = await authenticatedFetch(path, options);
  return response.status === 204 ? null : responseData(response);
}
const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });
const array = <T>(items: unknown[], parse: (value: unknown) => T): T[] => items.map(item => parse(item));
async function binary(path: string, options: RequestInit = {}) { const response = await authenticatedFetch(path, options); if (!response.ok) await responseData(response); return response.blob(); }
function transferDestination(address: string) {
  const base = new URL(API, window.location.origin), target = new URL(address, base);
  const local = ['localhost', '127.0.0.1'].includes(base.hostname) && ['localhost', '127.0.0.1'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && (local || target.origin === base.origin))) throw new Error('The private transfer target requires a secure connection.');
  return { target, sameOrigin: target.origin === base.origin };
}
async function privateDownload(path: string) {
  const { transfer } = await request(`${path}-ticket`, json({}));
  if (!transfer) return binary(path);
  const { target } = transferDestination(transfer.url);
  const response = await fetch(target, { headers: transfer.headers, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) await responseData(response);
  return response.blob();
}
async function nativeSignIn(input: { email: string; password: string; name?: string }, register: boolean): Promise<Me> {
  const { nativeAuth } = await import('./native-auth');
  const result = register ? await nativeAuth.signUp.email({ ...input, name: input.name ?? '' }) : await nativeAuth.signIn.email(input);
  if (result.error) throw new RequestError(result.error.message ?? 'Sign-in failed. Please try again.', result.error.status ?? 400, result.error.code);
  const jwt = await nativeAuth.convex.token();
  if (jwt.error || !jwt.data?.token) throw new RequestError('The account session could not be verified. Sign in again.', 401);
  const guest = existingGuest();
  const data = await responseData(await fetch(`${API}/auth/native-session`, { ...json({ token: jwt.data.token }), credentials: 'include', headers: { 'Content-Type': 'application/json', ...(guest ? { Authorization: `Bearer ${guest}` } : {}) }, signal: AbortSignal.timeout(20000) }));
  localStorage.removeItem(KEY); invalidateAccess();
  return { identity: IdentitySchema.parse(data.identity), preferences: LearnerPreferencesSchema.parse(data.preferences), revision: data.revision };
}
export const api = {
  me: inspectIdentity,
  async usage(): Promise<UsageSummary> { return request('/v1/me/usage'); },
  async authCapabilities(): Promise<{ native: boolean; oidc: boolean; passwordRecovery: false; emailVerification: false }> { return responseData(await fetch(`${API}/auth/config`, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10000) })); },
  nativeSignUp: (input: { name: string; email: string; password: string }) => nativeSignIn(input, true),
  nativeSignIn: (input: { email: string; password: string }) => nativeSignIn(input, false),
  async preferences() { const data = await request('/v1/me/preferences'); return { preferences: LearnerPreferencesSchema.parse(data.preferences), revision: data.revision as number }; },
  async savePreferences(preferences: LearnerPreferences, revision: number) { const data = await request('/v1/me/preferences', json({ preferences: LearnerPreferencesSchema.parse(preferences), revision }, 'PATCH')); return { preferences: LearnerPreferencesSchema.parse(data.preferences), revision: data.revision as number }; },
  async login() { invalidateAccess(); const token = existingGuest(); const data = await responseData(await fetch(`${API}/auth/login`, { ...json({}), credentials: 'include', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })); invalidateAccess(); return String(data.url); },
  async logout() { invalidateAccess(); await request('/auth/logout', json({})); const { nativeAuth } = await import('./native-auth'); await nativeAuth.signOut(); localStorage.removeItem(KEY); invalidateAccess(); },
  async deleteAccount() { invalidateAccess(); await request('/v1/me', { method: 'DELETE' }); localStorage.removeItem(KEY); invalidateAccess(); },
  async createLesson(input: CreateLesson) { const data = await request('/v1/lessons', json(CreateLessonSchema.parse(input))); return SessionSchema.parse(data.session); },
  async editSession(id: string, input: { title?: string; archived?: boolean }) { const data = await request(sessionPath(id), json(input, 'PATCH')); return SessionSchema.parse(data.session); },
  async resume(id: string) { const data = await request(`${sessionPath(id)}/resume`, json({})); return SessionSchema.parse(data.session); },
  async sources(): Promise<Source[]> { const data = await request('/v1/sources'); return array(data.sources, SourceSchema.parse); },
  async uploadSource(file: File, title = file.name) {
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Choose a nonempty PDF, image or text file no larger than 10 MB.');
    const mimeType = file.type || (/\.txt$/i.test(file.name) ? 'text/plain' : /\.pdf$/i.test(file.name) ? 'application/pdf' : '');
    const bytes = await file.arrayBuffer(), hash = await crypto.subtle.digest('SHA-256', bytes);
    const checksum = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const intent = UploadIntentSchema.parse({ title, filename: file.name, mimeType, bytes: file.size, checksum });
    const upload = await request('/v1/sources/uploads', json(intent)); const source = SourceSchema.parse(upload.source);
    const { target: destination, sameOrigin } = transferDestination(upload.uploadUrl);
    const response = await fetch(destination, { method: 'PUT', headers: upload.headers, body: file, credentials: sameOrigin ? 'include' : 'omit', redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('The file could not be uploaded. Retry from the library.');
    const completed = await request(`/v1/sources/${encodeURIComponent(source.id)}/complete`, json({})); return SourceSchema.parse(completed.source);
  },
  async retrySource(id: string) { const data = await request(`/v1/sources/${encodeURIComponent(id)}/retry`, json({})); return SourceSchema.parse(data.source); },
  async deleteSource(id: string) { await request(`/v1/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  sourceDownload: (id: string) => privateDownload(`/v1/sources/${encodeURIComponent(id)}/download`),
  async learning(id: string): Promise<LearningState> {
    const data = await request(`${sessionPath(id)}/learning`);
    return { assessments: array(data.assessments, PublicAssessmentSchema.parse), attempts: data.attempts.map((value: { attempt: unknown; evaluation: unknown }) => ({ attempt: AssessmentAttemptSchema.parse(value.attempt), evaluation: AssessmentEvaluationSchema.parse(value.evaluation) })), mastery: array(data.mastery, MasteryEstimateSchema.parse), cards: array(data.cards, LearningCardSchema.parse), studyPack: data.studyPack ? StudyPackSchema.parse(data.studyPack) : undefined, artifacts: array(data.artifacts, ArtifactSchema.parse) };
  },
  async presentAssessment(id: string, assessmentId: string) { const data = await request(`${sessionPath(id)}/assessments`, json({ assessmentId })); return { assessment: PublicAssessmentSchema.parse(data.assessment), presentation: AssessmentPresentationSchema.parse(data.presentation) }; },
  async hint(id: string, presentationId: string, hintId?: string) { const data = await request(`${sessionPath(id)}/assessments/${encodeURIComponent(presentationId)}/hint`, json({ hintId })); return { hint: data.hint as { id: string; text: string }, presentation: AssessmentPresentationSchema.parse(data.presentation) }; },
  async reveal(id: string, presentationId: string) { const data = await request(`${sessionPath(id)}/assessments/${encodeURIComponent(presentationId)}/reveal`, json({})); return { explanation: String(data.explanation), presentation: AssessmentPresentationSchema.parse(data.presentation) }; },
  async submitAssessment(id: string, input: SubmitAssessment) { const data = await request(`${sessionPath(id)}/attempts`, json(input)); return { attempt: AssessmentAttemptSchema.parse(data.attempt), evaluation: AssessmentEvaluationSchema.parse(data.evaluation), mastery: array(data.mastery, MasteryEstimateSchema.parse) }; },
  async appeal(id: string, attemptId: string, reason: string) { const data = await request(`${sessionPath(id)}/attempts/${encodeURIComponent(attemptId)}/appeal`, json({ reason })); return { attempt: AssessmentAttemptSchema.parse(data.attempt), evaluation: AssessmentEvaluationSchema.parse(data.evaluation), mastery: array(data.mastery, MasteryEstimateSchema.parse) }; },
  async generateAssessment(id: string) { const data = await request(`${sessionPath(id)}/generate-assessment`, json({})); return ArtifactSchema.parse(data.artifact ?? data); },
  async notes(id: string, notes: string, revision: number) { const data = await request(`${sessionPath(id)}/notes`, json({ notes, revision }, 'PATCH')); return SessionSchema.parse(data.session); },
  async lessonPrivacy(id: string, input: { revision: number; retainTranscript?: boolean; retainRecapAudio?: boolean; retentionDays?: number }) { const data = await request(`${sessionPath(id)}/privacy`, json(input, 'PATCH')); return SessionSchema.parse(data.session); },
  async createArtifact(id: string, kind: 'study-pack' | 'recap' | 'cards' | 'export', format?: 'markdown' | 'pdf' | 'csv' | 'json') { const data = await request(`${sessionPath(id)}/artifacts`, json({ kind, format })); return ArtifactSchema.parse(data.artifact); },
  async retryArtifact(id: string) { const data = await request(`/v1/artifacts/${encodeURIComponent(id)}/retry`, json({})); return ArtifactSchema.parse(data.artifact); },
  artifactDownload: (id: string) => privateDownload(`/v1/artifacts/${encodeURIComponent(id)}/download`),
  async dueReviews() { const data = await request('/v1/reviews/due'); return { cards: array(data.cards, LearningCardSchema.parse), total: data.total as number }; },
  async editCard(id: string, input: { revision: number; front?: string; back?: string; hint?: string; explanation?: string; cloze?: LearningCard['cloze']; status?: 'active' | 'discarded' | 'needs-correction' }) { const data = await request(`/v1/flashcards/${encodeURIComponent(id)}`, json(input, 'PATCH')); return LearningCardSchema.parse(data.card); },
  async regenerateCard(id: string) { const data = await request(`/v1/flashcards/${encodeURIComponent(id)}/regenerate`, json({})); return LearningCardSchema.parse(data.card); },
  async mergeCard(id: string, targetId: string) { const data = await request(`/v1/flashcards/${encodeURIComponent(id)}/merge`, json({ targetId })); return LearningCardSchema.parse(data.card); },
  async answerCard(id: string, text: string, mode: 'typed' | 'spoken') { const data = await request(`/v1/reviews/${encodeURIComponent(id)}/answer`, json({ text, mode })); return { feedback: String(data.feedback), suggestedRating: data.suggestedRating as ReviewSubmission['rating'] | undefined }; },
  async reviewCard(id: string, input: ReviewSubmission) { const data = await request(`/v1/reviews/${encodeURIComponent(id)}/attempts`, json(input)); return ReviewReceiptSchema.parse(data.receipt); },
  cardSpeech: (id: string) => binary(`/v1/reviews/${encodeURIComponent(id)}/speech`, json({})),
  async dictation(pcm: string, signal?: AbortSignal) { const data = await request('/v1/dictation', { ...json({ pcm, sampleRate: 16000 }), signal }); return String(data.text); },
  async shares(sessionId: string) { const data = await request(`/v1/share-links?sessionId=${encodeURIComponent(sessionId)}`); return array(data.links, ShareLinkSchema.parse); },
  async createShare(sessionId: string, expiresInDays: number, includeNotes: boolean, includeCards: boolean) { const data = await request('/v1/share-links', json({ sessionId, expiresInDays, includeNotes, includeCards })); return { link: ShareLinkSchema.parse(data.link), url: String(data.url) }; },
  async revokeShare(id: string) { await request(`/v1/share-links/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  async publicShare(token: string) { const data = await responseData(await fetch(`${API}/v1/shares/${encodeURIComponent(token)}`, { credentials: 'omit', cache: 'no-store' })); return StudyPackSchema.parse(data.pack); },
  async voiceTicket(id: string, signal?: AbortSignal) { return VoiceTicketSchema.parse(await request(`/v1/sessions/${encodeURIComponent(id)}/voice-ticket`, { method: 'POST', body: '{}', signal })); },
  async health() { const data = await responseData(await fetch(`${API}/health/live`, { signal: AbortSignal.timeout(5000) })); return CapabilitiesSchema.parse(data.providers); },
  async list(): Promise<Session[]> { const data = await request('/v1/sessions'); return data.sessions.map((s: unknown) => SessionSchema.parse(s)); },
  async create(topic: Topic, mode: 'sample' | 'live') { const data = await request('/v1/sessions', { method: 'POST', body: JSON.stringify({ topic, mode }) }); return SessionSchema.parse(data.session); },
  async session(id: string) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}`); return SessionSchema.parse(data.session); },
  async message(id: string, text: string, selectedNodeId?: string, selection?: SelectionContext, metadata?: { requestId?: string; practiceResponse?: PracticeResponse }) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, selectedNodeId, selection, ...metadata }) }); return SessionSchema.parse(data.session); },
  async boardOperations(id: string, transaction: BoardTransaction) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/board-operations`, { method: 'POST', body: JSON.stringify(transaction) }); return SessionSchema.parse(data.session); },
  async map(id: string, update: MapUpdate) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/map`, { method: 'PATCH', body: JSON.stringify(update) }); return SessionSchema.parse(data.session); },
  async explainImage(id: string, text: string, selection: SelectionContext, image: string) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/explain-image`, { method: 'POST', body: JSON.stringify({ text, selection, image: { mimeType: 'image/png', data: image } }) }); return SessionSchema.parse(data.session); },
  async board(id: string, board: Board, revision: number) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/board`, { method: 'PATCH', body: JSON.stringify({ board, revision }) }); return SessionSchema.parse(data.session); },
  async end(id: string) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/end`, { method: 'POST', body: '{}' }); return SessionSchema.parse(data.session); },
  async remove(id: string) { await request(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  speech: (id: string, messageId: string) => binary(`${sessionPath(id)}/speech`, json({ messageId })),
  voicePreview: (voiceId: string) => binary(`/v1/voices/${encodeURIComponent(voiceId)}/preview`, json({})),
};
export function voiceSocketUrl(ticket: string) { const url = new URL(`${API}/v1/voice`, typeof window === 'undefined' ? undefined : window.location?.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket); return url.toString(); }
export function errorText(error: unknown) { return error instanceof TypeError ? 'We couldn’t reach your learning workspace. Check that the server is running, then try again.' : error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename.replace(/[\\/:*?"<>|]/g, '-'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function downloadSummary(session: Session) {
  const text = `# ${session.title}\n\n${session.mode === 'sample' ? '> Guided sample lesson. Responses are prepared examples, not live AI.\n\n' : ''}${session.summary || '## Conversation\n\n' + session.messages.map(m => `**${m.role === 'tutor' ? 'Tutor' : 'You'}:** ${m.text}`).join('\n\n')}\n\n## Review cards\n\n${session.flashcards.map(c => `### ${c.front}\n\n${c.back}`).join('\n\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `milli-${session.topic}-notes.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
