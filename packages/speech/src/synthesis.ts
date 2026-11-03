import { Buffer } from 'node:buffer';

const ENDPOINT = 'https://tts.us.assemblyai.com/v1/speech';
const MAX_TEXT_CODE_POINTS = 2_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Implemented capabilities, not the entire provider's advertised feature set. */
export const SPEECH_CAPABILITIES = Object.freeze({
  provider: 'assemblyai',
  httpSynthesis: true,
  streamingSynthesis: true,
  streamingTranscription: true,
  liveWordTimings: false,
  wordBoundaries: true,
  wordBoundaryDelivery: 'after-flush',
  credentialedStreamingVerified: false,
  defaultVoiceId: 'aai-audrey',
  region: 'us',
  maxTextCodePoints: MAX_TEXT_CODE_POINTS,
} as const);

export type SpeechErrorCode = 'invalid-input' | 'not-configured' | 'aborted' | 'timeout'
  | 'authentication' | 'rate-limited' | 'provider-error' | 'invalid-audio' | 'audio-too-large'
  | 'protocol-error' | 'backpressure' | 'busy' | 'closed' | 'limit-exceeded';

/** Safe to expose the message/code; never includes provider response bodies. */
export class SpeechError extends Error {
  readonly name = 'SpeechError';
  constructor(readonly code: SpeechErrorCode, message: string, readonly status?: number) {
    super(message);
  }
}

export interface SynthesizeSpeechInput {
  text: string;
  apiKey: string;
  voiceId?: string;
  signal?: AbortSignal;
}
export interface SpeechResult { audio: Buffer; contentType: 'audio/wav' }
export interface SpeechDependencies {
  /** Inject only from trusted server/test code, never from HTTP user input. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function invalidAudio(): SpeechError {
  return new SpeechError('invalid-audio', 'The speech provider returned an invalid WAV file.');
}

function assertWave(audio: Buffer): void {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF'
      || audio.toString('ascii', 8, 12) !== 'WAVE') throw invalidAudio();
  let hasFormat = false;
  let hasData = false;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const kind = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > audio.length) throw invalidAudio();
    if (kind === 'fmt ') {
      if (size < 16) throw invalidAudio();
      const encoding = audio.readUInt16LE(offset + 8);
      const channels = audio.readUInt16LE(offset + 10);
      const sampleRate = audio.readUInt32LE(offset + 12);
      if (![1, 3, 0xfffe].includes(encoding) || channels < 1 || channels > 2
          || sampleRate < 8_000 || sampleRate > 192_000) throw invalidAudio();
      hasFormat = true;
    }
    if (kind === 'data' && size > 0) hasData = true;
    offset = end + size % 2;
  }
  if (!hasFormat || !hasData) throw invalidAudio();
}

/** HTTP TTS only: no live STT/streaming/cancellation-at-provider guarantee. */
export async function synthesizeSpeech(
  input: SynthesizeSpeechInput,
  dependencies: SpeechDependencies = {},
): Promise<SpeechResult> {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || [...text].length > MAX_TEXT_CODE_POINTS) {
    throw new SpeechError('invalid-input', `Speech text must contain 1–${MAX_TEXT_CODE_POINTS} characters.`);
  }
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || /[\r\n]/.test(input.apiKey)) {
    throw new SpeechError('not-configured', 'AssemblyAI speech is not configured on the server.');
  }
  const voiceId = input.voiceId ?? SPEECH_CAPABILITIES.defaultVoiceId;
  if (typeof voiceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(voiceId)) {
    throw new SpeechError('invalid-input', 'The selected speech voice is invalid.');
  }
  const timeoutMs = dependencies.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new SpeechError('invalid-input', 'Speech timeout must be between 1 and 60000 milliseconds.');
  }
  if (input.signal?.aborted) throw new SpeechError('aborted', 'Speech generation was cancelled.');

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortError = () => new SpeechError(timedOut ? 'timeout' : 'aborted',
    timedOut ? 'The speech provider did not respond in time.' : 'Speech generation was cancelled.');
  // Bound even a custom transport/reader that ignores AbortSignal.
  let rejectAbort: ((error: SpeechError) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort?.(abortError());
    void reader?.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);

  try {
    const response = await bounded((dependencies.fetchImpl ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: input.apiKey.trim(), 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({ text, voice_id: voiceId, container: 'wav', stream: false }),
      redirect: 'error',
      signal: controller.signal,
    }));
    if (controller.signal.aborted) throw abortError();
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new SpeechError('authentication', 'The speech provider rejected the server credentials.', status);
      }
      if (status === 429) throw new SpeechError('rate-limited', 'Speech is temporarily rate limited. Try again shortly.', status);
      throw new SpeechError('provider-error', 'The speech provider could not generate audio.', status);
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!type || !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(type) || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw invalidAudio();
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_AUDIO_BYTES) {
      void response.body.cancel().catch(() => undefined);
      throw new SpeechError('audio-too-large', 'The generated audio exceeded the allowed size.');
    }
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { value, done } = await bounded(reader.read());
      if (controller.signal.aborted) throw abortError();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_AUDIO_BYTES) throw new SpeechError('audio-too-large', 'The generated audio exceeded the allowed size.');
      chunks.push(Buffer.from(value));
    }
    const audio = Buffer.concat(chunks, received);
    assertWave(audio);
    return { audio, contentType: 'audio/wav' };
  } catch (error) {
    if (controller.signal.aborted) throw abortError();
    if (error instanceof SpeechError) throw error;
    // Fetch errors can contain URLs, headers or proxy diagnostics. Do not forward them.
    throw new SpeechError('provider-error', 'Unable to reach the speech provider.');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onCallerAbort);
    controller.signal.removeEventListener('abort', onAbort);
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
