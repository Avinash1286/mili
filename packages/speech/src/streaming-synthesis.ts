import { Buffer } from 'node:buffer';
import type WebSocket from 'ws';
import { SpeechError, validateLanguage, type SpeechLanguage } from './synthesis.js';
import { aborted, connectSocket, disposeSocket, nonnegativeInteger, parseFrame, protocolError, providerError,
  record, sendJson, sessionInfo, settings, validateKey, validateVoice,
  type StreamingDependencies, type StreamingSettings } from './transport.js';

export const TTS_SAMPLE_RATE = 24_000;
export interface SynthesisIdentity { providerSessionId: string; flushId: number }
export interface SynthesisDone extends SynthesisIdentity { audioDurationMs: number }
export interface SynthesisBoundaries extends SynthesisIdentity {
  /** Provider session timeline. Subtract this from startMs/endMs before playback mapping. */
  audioStartMs: number;
  words: { word: string; startMs: number; endMs: number; confidence: number }[];
}
export interface SynthesizerInput {
  apiKey: string; voiceId?: string; language?: SpeechLanguage; signal?: AbortSignal;
  onAudio: (pcm: Uint8Array, identity: SynthesisIdentity) => void;
  onBoundaries?: (frame: SynthesisBoundaries) => void;
  onError: (error: SpeechError) => void;
}
export interface SpeakOptions {
  signal?: AbortSignal;
  /** Negotiated Begin, before any audio; does not imply browser playback has started. */
  onStart?: (identity: SynthesisIdentity) => void;
  /** All audio delivered by provider, NOT playback completion. Boundaries can arrive later. */
  onDone?: (result: SynthesisDone) => void;
}
export interface Synthesizer {
  /** One request at a time, 1–2000 code points. Resolves after provider Termination. */
  speak(text: string, options?: SpeakOptions): Promise<void>;
  /** Immediately drops frames; waits at most 750ms for Cancelled, then closes the socket. */
  cancel(): Promise<void>;
  close(): void;
}
interface Request { promise: Promise<void>; cancel(): Promise<void>; close(): void }
const MAX_AUDIO_BYTES = 120 * TTS_SAMPLE_RATE * 2;

/** Fresh socket/flush namespace per output: more connection overhead, bounded cancellation isolation. */
export async function createSynthesizer(input: SynthesizerInput, dependencies: StreamingDependencies = {}): Promise<Synthesizer> {
  validateKey(input.apiKey);
  const voiceId = input.voiceId ?? 'aai-audrey';
  validateVoice(voiceId); validateLanguage(input.language ?? 'english');
  if (input.signal?.aborted) throw aborted();
  const config = settings(dependencies);
  let closed = false, active: Request | undefined;
  let cancelling: Promise<void> | undefined;
  function close(): void {
    if (closed) return;
    closed = true;
    input.signal?.removeEventListener('abort', close);
    active?.close(); active = undefined;
  }
  input.signal?.addEventListener('abort', close, { once: true });
  if (input.signal?.aborted) close();
  return {
    async speak(text, options = {}) {
      if (cancelling) await cancelling;
      if (closed) throw new SpeechError('closed', 'The speech synthesizer is closed.');
      if (active) throw new SpeechError('busy', 'A speech request is already running.');
      if (options.signal?.aborted) throw aborted();
      if (typeof text !== 'string' || !text.trim() || [...text].length > 2000) {
        throw new SpeechError('invalid-input', 'Speech text must contain 1–2000 characters.');
      }
      const request = startRequest(input, voiceId, text, options, dependencies, config);
      active = request;
      try { await request.promise; } finally { if (active === request) active = undefined; }
    },
    async cancel() {
      if (cancelling) return cancelling;
      if (!active) return;
      const request = active;
      cancelling = request.cancel();
      try { await cancelling; } finally {
        if (active === request) active = undefined;
        cancelling = undefined;
      }
    },
    close,
  };
}

function startRequest(input: SynthesizerInput, voiceId: string, text: string, options: SpeakOptions,
  dependencies: StreamingDependencies, config: StreamingSettings): Request {
  const url = new URL('wss://tts.us.assemblyai.com/v1/ws');
  url.search = new URLSearchParams({ voice_id: voiceId, model_id: 'assemblyai-tts-1', language: input.language ?? 'english',
    sample_rate: String(TTS_SAMPLE_RATE), encoding: 'pcm_s16le', word_boundaries: 'true', inactivity_timeout: '30' }).toString();
  let ws: WebSocket;
  try { ws = connectSocket(url, input.apiKey, dependencies, config); } catch { throw providerError(); }
  let finished = false, cancelled = false, began = false, flushed = false, boundariesSeen = false, terminating = false;
  let totalBytes = 0, identity: SynthesisIdentity | undefined;
  let resolve!: () => void, reject!: (error: SpeechError) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  let resolveCancel: (() => void) | undefined;
  let cancelPromise: Promise<void> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  const connectTimer = setTimeout(() => fail(new SpeechError('timeout', 'The speech provider did not start in time.')), config.connectTimeoutMs);
  const deadline = setTimeout(() => fail(new SpeechError('timeout', 'The speech request exceeded its time limit.')), config.requestTimeoutMs);
  function clean(): void {
    clearTimeout(connectTimer); clearTimeout(deadline); clearTimeout(cancelTimer); clearTimeout(idleTimer); clearTimeout(lifetimeTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
  function finish(error?: SpeechError, notify = false): void {
    if (finished) return;
    finished = true; clean(); disposeSocket(ws);
    if (error) reject(error); else resolve();
    resolveCancel?.();
    if (notify && error) { try { input.onError(error); } catch { /* Always close the paid socket first. */ } }
  }
  function fail(error: SpeechError): void {
    if (cancelled) finish(aborted()); else finish(error, true);
  }
  function touch(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new SpeechError('timeout', 'The speech provider stopped responding.')), config.idleTimeoutMs);
  }
  function cancel(): Promise<void> {
    if (cancelPromise) return cancelPromise;
    if (finished) return Promise.resolve();
    // Invalidate BEFORE Cancel is written. Even an already-in-flight Audio frame is dropped.
    cancelled = true;
    cancelPromise = new Promise<void>(res => { resolveCancel = res; });
    if (!began || terminating) { finish(aborted()); return cancelPromise; }
    try { sendJson(ws, { type: 'Cancel' }); } catch { finish(aborted()); return cancelPromise; }
    cancelTimer = setTimeout(() => finish(aborted()), config.cancelTimeoutMs);
    return cancelPromise;
  }
  function onAbort(): void { void cancel(); }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  ws.on('unexpected-response', (_request, response) => { response.destroy(); fail(providerError(response.statusCode)); });
  ws.on('error', () => fail(providerError()));
  ws.on('close', code => fail(providerError(code)));
  ws.on('message', (raw, binary) => {
    if (finished) return;
    try {
      const frame = parseFrame(raw, binary);
      if (!['Begin', 'Error', 'Audio', 'FlushDone', 'WordBoundaries', 'Cancelled', 'Termination'].includes(String(frame.type))) return;
      if (cancelled) {
        if (frame.type === 'Cancelled' || frame.type === 'Termination' || frame.type === 'Error') finish(aborted());
        return; // Includes Audio/FlushDone/WordBoundaries racing with cancellation.
      }
      if (frame.type === 'Error') { fail(providerError(frame.error_code)); return; }
      if (frame.type === 'Begin') {
        if (began) throw protocolError();
        const info = sessionInfo(frame), c = info.configuration;
        if (c.sample_rate !== TTS_SAMPLE_RATE || c.encoding !== 'pcm_s16le' || c.model !== 'assemblyai-tts-1'
            || c.language !== (input.language ?? 'english') || typeof c.voice_id !== 'string' || c.voice_id.toLowerCase() !== voiceId.toLowerCase()
            || c.word_boundaries !== undefined && typeof c.word_boundaries !== 'boolean' || !record(c.limits)) throw protocolError();
        const maxText = c.limits.max_generate_text_length, maxBuffered = c.limits.text_max_buffer_chars;
        if (!nonnegativeInteger(maxText) || maxText < 1 || !nonnegativeInteger(maxBuffered) || maxBuffered < 1) throw protocolError();
        if ([...text].length > Math.min(maxText, maxBuffered)) throw new SpeechError('limit-exceeded', 'The speech text exceeds the negotiated provider limit.');
        began = true; identity = { providerSessionId: info.id, flushId: 0 };
        clearTimeout(connectTimer); touch();
        lifetimeTimer = setTimeout(() => fail(new SpeechError('timeout', 'The speech provider session expired.')),
          Math.min(config.maxSessionMs, Math.max(1, info.expiresAt - Date.now() - 1000)));
        options.onStart?.({ ...identity });
        if (finished || cancelled) return;
        sendJson(ws, { type: 'Generate', text });
        sendJson(ws, { type: 'Flush' });
        return;
      }
      if (!began || !identity) throw protocolError();
      touch();
      if (frame.type === 'Audio') {
        if (flushed || frame.flush_id !== 0 || typeof frame.audio !== 'string' || !frame.audio.length
            || frame.audio.length > 1024 * 1024 || frame.audio.length % 4
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.audio)) throw protocolError();
        const pcm = Buffer.from(frame.audio, 'base64');
        if (!pcm.length || pcm.length % 2 || pcm.toString('base64') !== frame.audio) throw new SpeechError('invalid-audio', 'The speech provider returned invalid PCM audio.');
        totalBytes += pcm.length;
        if (totalBytes > MAX_AUDIO_BYTES) throw new SpeechError('audio-too-large', 'The generated audio exceeded two minutes.');
        input.onAudio(pcm, { ...identity });
      } else if (frame.type === 'FlushDone') {
        if (flushed || frame.flush_id !== 0 || !nonnegativeInteger(frame.audio_duration_ms)
            || Math.abs(frame.audio_duration_ms - totalBytes * 1000 / (TTS_SAMPLE_RATE * 2)) > 100) throw protocolError();
        flushed = true;
        options.onDone?.({ ...identity, audioDurationMs: frame.audio_duration_ms });
        if (finished || cancelled) return;
        // Terminate AFTER FlushDone keeps Cancel useful while synthesis is active.
        // Termination drains pending (best-effort) boundaries; don't require a boundary frame.
        terminating = true; sendJson(ws, { type: 'Terminate' });
      } else if (frame.type === 'WordBoundaries') {
        // Word timings are best-effort: ignore a missing, duplicate or malformed frame and keep the audio.
        if (!flushed || boundariesSeen || frame.flush_id !== 0 || !nonnegativeInteger(frame.audio_start_ms)
            || !Array.isArray(frame.words) || frame.words.length > 2000) return;
        const start = frame.audio_start_ms;
        const valid = (word: unknown): word is { word: string; start: number; end: number; confidence: number } => record(word) && typeof word.word === 'string' && word.word.length <= 4000
          && nonnegativeInteger(word.start) && nonnegativeInteger(word.end) && word.start >= start && word.end >= word.start
          && word.end - start <= totalBytes * 1000 / (TTS_SAMPLE_RATE * 2) + 100
          && typeof word.confidence === 'number' && Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 1;
        boundariesSeen = true;
        if (!frame.words.every(valid)) return;
        const words = frame.words.map((word: { word: string; start: number; end: number; confidence: number }) => ({ word: word.word, startMs: word.start, endMs: word.end, confidence: word.confidence }));
        input.onBoundaries?.({ ...identity, audioStartMs: start, words });
      } else if (frame.type === 'Termination') {
        if (!flushed) throw protocolError();
        finish();
      } else if (frame.type === 'Cancelled') {
        throw protocolError(); // Acknowledgement without this request's own Cancel is not ours.
      }
      // Future frame types are ignored, as required by the provider protocol.
    } catch (error) { fail(error instanceof SpeechError ? error : protocolError()); }
  });
  if (options.signal?.aborted) onAbort();
  return { promise, cancel, close() { cancelled = true; finish(aborted()); } };
}
