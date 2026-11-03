import { Buffer } from 'node:buffer';
import { SpeechError } from './synthesis.js';
import { aborted, connectSocket, disposeSocket, nonnegativeInteger, parseFrame, protocolError, providerError,
  sendJson, sessionInfo, settings, validateKey, type StreamingDependencies } from './transport.js';

export const STT_SAMPLE_RATE = 16_000;
export const STT_MODEL = 'universal-3-6-pro';
export interface TranscriptTurn {
  /** Provider connection plus turn_order; formatting updates keep this identity. */
  turnId: string; providerSessionId: string; turnOrder: number; text: string;
}
export interface SpeechStarted { providerSessionId: string; timestampMs: number }
export interface TranscriberInput {
  apiKey: string; model?: string; signal?: AbortSignal;
  onPartial: (turn: TranscriptTurn) => void;
  onFinal: (turn: TranscriptTurn) => void;
  onSpeechStarted: (event: SpeechStarted) => void;
  onError: (error: SpeechError) => void;
}
export interface Transcriber {
  /** Raw little-endian signed PCM16, mono, 16 kHz. Prefer 1600-byte/50 ms chunks. */
  sendAudio(pcm: Uint8Array): void;
  forceEndpoint(): void;
  /** Intentional close drops all subsequent partials/finals. */
  close(): void;
}

export async function createTranscriber(input: TranscriberInput, dependencies: StreamingDependencies = {}): Promise<Transcriber> {
  validateKey(input.apiKey);
  const model = input.model ?? STT_MODEL;
  // Pin the semantic endpointing model. Other models have different final/formatting semantics.
  if (model !== STT_MODEL) throw new SpeechError('invalid-input', `Streaming transcription requires ${STT_MODEL}.`);
  if (input.signal?.aborted) throw aborted();
  const config = settings(dependencies);
  const url = new URL('wss://streaming.assemblyai.com/v3/ws');
  url.search = new URLSearchParams({ sample_rate: String(STT_SAMPLE_RATE), encoding: 'pcm_s16le',
    speech_model: model, mode: 'balanced', min_turn_silence: '400', max_turn_silence: '1600',
    include_partial_turns: 'true', session_heartbeat: 'true', inactivity_timeout: '30' }).toString();
  let socket;
  try { socket = connectSocket(url, input.apiKey, dependencies, config); } catch { throw providerError(); }
  const ws = socket;
  let ready = false, closed = false, providerSessionId = '', lastCommitted = -1, lastSeen = -1;
  let lastSpeechTimestamp = -1, lastForceEndpoint = -Infinity;
  let lastInputAt = performance.now(), audioCredit = 64_000, lastCreditAt = performance.now();
  let remainder: Buffer = Buffer.alloc(0);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let inputWatchdog: ReturnType<typeof setInterval> | undefined;
  let resolveReady!: (value: Transcriber) => void, rejectReady!: (error: SpeechError) => void;
  const result = new Promise<Transcriber>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const connectTimer = setTimeout(() => fail(new SpeechError('timeout', 'The transcription provider did not start in time.')), config.connectTimeoutMs);

  function clean(): void {
    clearTimeout(connectTimer); clearTimeout(idleTimer); clearTimeout(lifetimeTimer); clearInterval(inputWatchdog);
    input.signal?.removeEventListener('abort', onAbort);
    remainder = Buffer.alloc(0);
  }
  function finish(error?: SpeechError, notify = true): void {
    if (closed) return;
    closed = true; clean();
    try { sendJson(ws, { type: 'Terminate' }); } catch { /* Socket may already be gone. */ }
    disposeSocket(ws);
    if (!ready) rejectReady(error ?? aborted());
    if (error && notify) { try { input.onError(error); } catch { /* Consumer exceptions must not retain a paid socket. */ } }
  }
  function fail(error: SpeechError): void { finish(error); }
  function onAbort(): void { finish(aborted(), false); }
  function touch(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new SpeechError('timeout', 'The transcription provider stopped responding.')), config.idleTimeoutMs);
  }
  const transcriber: Transcriber = {
    sendAudio(pcm) {
      if (closed || !ready) throw new SpeechError('closed', 'The transcription connection is closed.');
      if (!(pcm instanceof Uint8Array) || pcm.byteLength < 2 || pcm.byteLength > 16_000 || pcm.byteLength % 2) {
        throw new SpeechError('invalid-input', 'Microphone chunks must contain 1–8000 complete PCM16 samples.');
      }
      // A two-second burst allowance accommodates scheduling jitter, not file-sized backlog.
      const now = performance.now();
      audioCredit = Math.min(64_000, audioCredit + (now - lastCreditAt) * 1.25 * STT_SAMPLE_RATE * 2 / 1000);
      lastCreditAt = now;
      if (pcm.byteLength > audioCredit || ws.bufferedAmount + pcm.byteLength > 64 * 1024) {
        const error = new SpeechError('backpressure', 'Microphone audio arrived faster than it could be processed.');
        fail(error); throw error;
      }
      // Normalize to 50ms frames, including implementations enforcing the documented minimum.
      const bytes = Buffer.concat([remainder, pcm]);
      let offset = 0;
      try {
        for (; offset + 1600 <= bytes.length; offset += 1600) ws.send(bytes.subarray(offset, offset + 1600));
      } catch { const error = providerError(); fail(error); throw error; }
      remainder = Buffer.from(bytes.subarray(offset));
      audioCredit -= pcm.byteLength; lastInputAt = now;
    },
    forceEndpoint() {
      if (closed) throw new SpeechError('closed', 'The transcription connection is closed.');
      if (performance.now() - lastForceEndpoint < 250) return;
      lastForceEndpoint = performance.now();
      try {
        if (remainder.length) {
          if (ws.bufferedAmount > 64 * 1024 - 1600) throw new SpeechError('backpressure', 'The speech connection is too slow.');
          const finalChunk = Buffer.alloc(1600); remainder.copy(finalChunk); remainder = Buffer.alloc(0);
          ws.send(finalChunk);
        }
        sendJson(ws, { type: 'ForceEndpoint' });
      } catch (error) { fail(error instanceof SpeechError ? error : providerError()); }
    },
    close() { finish(undefined, false); },
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  ws.on('unexpected-response', (_request, response) => { response.destroy(); fail(providerError(response.statusCode)); });
  ws.on('error', () => fail(providerError()));
  ws.on('close', code => fail(providerError(code)));
  ws.on('message', (raw, binary) => {
    if (closed) return;
    try {
      const frame = parseFrame(raw, binary);
      if (!['Begin', 'Error', 'SpeechStarted', 'Turn', 'Heartbeat', 'Termination'].includes(String(frame.type))) return;
      if (frame.type === 'Error') { fail(providerError(frame.error_code)); return; }
      if (frame.type === 'Begin') {
        if (ready) throw protocolError();
        const info = sessionInfo(frame);
        if (info.configuration.model !== model) throw protocolError();
        // STT Begin does not currently echo these settings; validate them if added in future.
        if ((info.configuration.sample_rate !== undefined && info.configuration.sample_rate !== STT_SAMPLE_RATE)
            || (info.configuration.encoding !== undefined && info.configuration.encoding !== 'pcm_s16le')) throw protocolError();
        providerSessionId = info.id; ready = true; lastInputAt = performance.now(); clearTimeout(connectTimer); touch();
        lifetimeTimer = setTimeout(() => fail(new SpeechError('timeout', 'The transcription session reached its time limit. Reconnect to continue.')),
          Math.min(config.maxSessionMs, Math.max(1, info.expiresAt - Date.now() - 1000)));
        inputWatchdog = setInterval(() => {
          if (performance.now() - lastInputAt >= 15_000) fail(new SpeechError('timeout', 'No microphone audio was received. Reconnect to continue.'));
        }, 1000);
        resolveReady(transcriber); return;
      }
      if (!ready) throw protocolError();
      touch();
      if (frame.type === 'SpeechStarted') {
        if (!nonnegativeInteger(frame.timestamp)) throw protocolError();
        if (frame.timestamp <= lastSpeechTimestamp) return;
        lastSpeechTimestamp = frame.timestamp;
        input.onSpeechStarted({ providerSessionId, timestampMs: frame.timestamp });
      } else if (frame.type === 'Turn') {
        if (!nonnegativeInteger(frame.turn_order) || typeof frame.transcript !== 'string'
            || frame.transcript.length > 8000 || typeof frame.end_of_turn !== 'boolean'
            || typeof frame.turn_is_formatted !== 'boolean') throw protocolError();
        if (frame.turn_order <= lastCommitted || frame.turn_order < lastSeen) return;
        lastSeen = frame.turn_order;
        const turn = { providerSessionId, turnOrder: frame.turn_order,
          turnId: `${providerSessionId}:${frame.turn_order}`, text: frame.transcript.trim() };
        if (frame.end_of_turn && frame.turn_is_formatted) {
          lastCommitted = frame.turn_order;
          if (turn.text) input.onFinal(turn);
        } else if (turn.text) input.onPartial(turn);
      } else if (frame.type === 'Termination') {
        fail(new SpeechError('closed', 'The transcription provider ended the session. Reconnect to continue.'));
      }
      // Unknown event types are ignored for forward compatibility.
    } catch (error) { fail(error instanceof SpeechError ? error : protocolError()); }
  });
  if (input.signal?.aborted) onAbort();
  return result;
}
