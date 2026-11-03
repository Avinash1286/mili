import { Buffer } from 'node:buffer';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { SpeechError } from './synthesis.js';

export type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;
/** Server-owned injection only. These options must never come from browser input. */
export interface StreamingDependencies {
  webSocketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
  maxSessionMs?: number;
}
export interface StreamingSettings {
  connectTimeoutMs: number; idleTimeoutMs: number; requestTimeoutMs: number;
  cancelTimeoutMs: number; maxSessionMs: number;
}

export function settings(input: StreamingDependencies): StreamingSettings {
  const result = {
    connectTimeoutMs: input.connectTimeoutMs ?? 10_000,
    idleTimeoutMs: input.idleTimeoutMs ?? 20_000,
    requestTimeoutMs: input.requestTimeoutMs ?? 45_000,
    cancelTimeoutMs: input.cancelTimeoutMs ?? 750,
    maxSessionMs: input.maxSessionMs ?? 15 * 60_000,
  };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > (key === 'maxSessionMs' ? 60 * 60_000 : 120_000)) {
      throw new SpeechError('invalid-input', 'The speech connection timeout is invalid.');
    }
  }
  return result;
}

export function validateKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
    throw new SpeechError('not-configured', 'AssemblyAI speech is not configured on the server.');
  }
}
export function validateVoice(voiceId: string): void {
  if (typeof voiceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(voiceId)) {
    throw new SpeechError('invalid-input', 'The selected speech voice is invalid.');
  }
}
export function aborted(): SpeechError { return new SpeechError('aborted', 'Speech was cancelled.'); }
export function protocolError(): SpeechError { return new SpeechError('protocol-error', 'The speech provider returned an unexpected message or configuration.'); }
export function providerError(code?: unknown): SpeechError {
  if (code === 401 || code === 403 || code === 3001) return new SpeechError('authentication', 'The speech provider rejected the server credentials.');
  if (code === 429 || code === 3009 || code === 3010) return new SpeechError('rate-limited', 'Speech is temporarily rate limited. Try again shortly.');
  // STT uses 1008 for credentials, billing and session quotas; the code alone cannot disambiguate.
  if (code === 1008) return new SpeechError('authentication', 'Speech access was refused. Check server credentials, account credit and session rate limits.');
  if (code === 1009) return new SpeechError('limit-exceeded', 'The speech provider message exceeded the allowed size.');
  return new SpeechError('provider-error', 'The speech provider connection failed.');
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function parseFrame(raw: RawData, isBinary: boolean): Record<string, unknown> {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
  if (isBinary || bytes.length > 1024 * 1024) throw protocolError();
  let frame: unknown;
  try { frame = JSON.parse(bytes.toString('utf8')); } catch { throw protocolError(); }
  if (!record(frame) || typeof frame.type !== 'string') throw protocolError();
  return frame;
}
export function sessionInfo(frame: Record<string, unknown>): { id: string; expiresAt: number; configuration: Record<string, unknown> } {
  if (typeof frame.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(frame.id)
      || !nonnegativeInteger(frame.expires_at) || frame.expires_at * 1000 <= Date.now()
      || !record(frame.configuration)) throw protocolError();
  return { id: frame.id, expiresAt: frame.expires_at * 1000, configuration: frame.configuration };
}
export function connectSocket(url: URL, apiKey: string, dependencies: StreamingDependencies, config: StreamingSettings): WebSocket {
  // No redirects: the Authorization header must never follow another host.
  return (dependencies.webSocketFactory ?? ((target, options) => new WebSocket(target, options)))(url.toString(), {
    headers: { Authorization: apiKey.trim() }, followRedirects: false, perMessageDeflate: false,
    maxPayload: 1024 * 1024, handshakeTimeout: config.connectTimeoutMs,
  });
}
export function sendJson(socket: WebSocket, frame: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) throw new SpeechError('closed', 'The speech connection is closed.');
  if (socket.bufferedAmount > 64 * 1024) throw new SpeechError('backpressure', 'The speech connection is too slow. Reconnect to continue.');
  socket.send(JSON.stringify(frame));
}
/** Release listeners/resources, including a connection still in the handshake. */
export function disposeSocket(socket: WebSocket): void {
  socket.removeAllListeners('message');
  socket.removeAllListeners('open');
  socket.removeAllListeners('unexpected-response');
  socket.removeAllListeners('close');
  socket.removeAllListeners('error');
  socket.on('error', () => undefined); // terminate during CONNECTING can emit asynchronously.
  if (socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) { socket.terminate(); return; }
  socket.close(1000);
  const timer = setTimeout(() => socket.terminate(), 500);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}
