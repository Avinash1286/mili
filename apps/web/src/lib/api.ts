import { GuestResponseSchema, SessionSchema, CapabilitiesSchema, VoiceTicketSchema, type Session, type Topic, type Board, type BoardTransaction, type MapUpdate, type SelectionContext } from '@tokai/contracts';
const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const KEY = 'tokai.guest.v1';
let pendingGuest: Promise<string> | undefined;

export class RequestError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function responseData(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(data.message || data.error?.message || 'Something went wrong. Please try again.', response.status, data.code || data.error?.code);
  return data;
}
export async function guestToken(): Promise<string> {
  const saved = localStorage.getItem(KEY);
  if (saved) { try { const data = GuestResponseSchema.parse(JSON.parse(saved)); if (Date.parse(data.expiresAt) > Date.now() + 30000) return data.token; } catch {} }
  if (!pendingGuest) pendingGuest = (async () => { const response = await fetch(`${API}/v1/guest-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const data = GuestResponseSchema.parse(await responseData(response)); localStorage.setItem(KEY, JSON.stringify(data)); return data.token; })().finally(() => { pendingGuest = undefined; });
  return pendingGuest;
}
async function request(path: string, options: RequestInit = {}) {
  const token = await guestToken();
  const response = await fetch(`${API}${path}`, { ...options, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...options.headers } });
  if (response.status === 401) { localStorage.removeItem(KEY); throw new RequestError('Your guest access expired. Reload to start a new guest session.', 401); }
  return response.status === 204 ? null : responseData(response);
}
export const api = {
  async voiceTicket(id: string, signal?: AbortSignal) { return VoiceTicketSchema.parse(await request(`/v1/sessions/${encodeURIComponent(id)}/voice-ticket`, { method: 'POST', body: '{}', signal })); },
  async health() { const data = await responseData(await fetch(`${API}/health/live`, { signal: AbortSignal.timeout(5000) })); return CapabilitiesSchema.parse(data.providers); },
  async list(): Promise<Session[]> { const data = await request('/v1/sessions'); return data.sessions.map((s: unknown) => SessionSchema.parse(s)); },
  async create(topic: Topic, mode: 'sample' | 'live') { const data = await request('/v1/sessions', { method: 'POST', body: JSON.stringify({ topic, mode }) }); return SessionSchema.parse(data.session); },
  async session(id: string) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}`); return SessionSchema.parse(data.session); },
  async message(id: string, text: string, selectedNodeId?: string, selection?: SelectionContext) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, selectedNodeId, selection }) }); return SessionSchema.parse(data.session); },
  async boardOperations(id: string, transaction: BoardTransaction) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/board-operations`, { method: 'POST', body: JSON.stringify(transaction) }); return SessionSchema.parse(data.session); },
  async map(id: string, update: MapUpdate) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/map`, { method: 'PATCH', body: JSON.stringify(update) }); return SessionSchema.parse(data.session); },
  async explainImage(id: string, text: string, selection: SelectionContext, image: string) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/explain-image`, { method: 'POST', body: JSON.stringify({ text, selection, image: { mimeType: 'image/png', data: image } }) }); return SessionSchema.parse(data.session); },
  async board(id: string, board: Board, revision: number) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/board`, { method: 'PATCH', body: JSON.stringify({ board, revision }) }); return SessionSchema.parse(data.session); },
  async end(id: string) { const data = await request(`/v1/sessions/${encodeURIComponent(id)}/end`, { method: 'POST', body: '{}' }); return SessionSchema.parse(data.session); },
  async remove(id: string) { await request(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  async speech(id: string, messageId: string) { const token = await guestToken(); const response = await fetch(`${API}/v1/sessions/${encodeURIComponent(id)}/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ messageId }) }); if (!response.ok) await responseData(response); return response.blob(); }
};
export function voiceSocketUrl(ticket: string) { const url = new URL(`${API}/v1/voice`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket); return url.toString(); }
export function errorText(error: unknown) { return error instanceof TypeError ? 'We couldn’t reach your learning workspace. Check that the server is running, then try again.' : error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function downloadSummary(session: Session) {
  const text = `# ${session.title}\n\n${session.mode === 'sample' ? '> Guided sample lesson. Responses are prepared examples, not live AI.\n\n' : ''}${session.summary || '## Conversation\n\n' + session.messages.map(m => `**${m.role === 'tutor' ? 'Tutor' : 'You'}:** ${m.text}`).join('\n\n')}\n\n## Review cards\n\n${session.flashcards.map(c => `### ${c.front}\n\n${c.back}`).join('\n\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tokai-${session.topic}-notes.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
