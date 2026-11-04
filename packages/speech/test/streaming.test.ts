import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranscriber, type TranscriberInput } from '../src/transcription.js';
import { createSynthesizer, type SynthesizerInput } from '../src/streaming-synthesis.js';
import type { StreamingDependencies } from '../src/transport.js';

const secret = 'server-secret-must-not-be-exposed';
const servers: WebSocketServer[] = [];
const disposables: { close(): void }[] = [];
afterEach(async () => {
  for (const item of disposables.splice(0)) item.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  })));
});
async function provider(onConnect: (socket: WebSocket, index: number) => void, rejectionStatus?: number) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0,
    verifyClient: rejectionStatus ? (_info, done) => done(false, rejectionStatus, 'Denied') : undefined });
  servers.push(server);
  await once(server, 'listening');
  let count = 0;
  server.on('connection', socket => { socket.on('error', () => undefined); onConnect(socket, count++); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP address');
  const factory = vi.fn<NonNullable<StreamingDependencies['webSocketFactory']>>((url, options) =>
    new WebSocket(`ws://127.0.0.1:${address.port}/${new URL(url).search}`, options));
  return { server, factory, dependencies: { webSocketFactory: factory, connectTimeoutMs: 500, idleTimeoutMs: 2000, requestTimeoutMs: 3000 } };
}
const send = (socket: WebSocket, frame: unknown) => socket.send(JSON.stringify(frame));
const sttBegin = (id = 'stt-session') => ({ type: 'Begin', id, expires_at: Math.floor(Date.now() / 1000) + 3600,
  configuration: { model: 'universal-3-6-pro', mode: 'balanced' } });
const ttsBegin = (id = 'tts-session') => ({ type: 'Begin', id, expires_at: Math.floor(Date.now() / 1000) + 3600,
  configuration: { sample_rate: 24000, encoding: 'pcm_s16le', language: 'english', voice_id: 'aai-audrey',
    model: 'assemblyai-tts-1', word_boundaries: true, limits: { max_generate_text_length: 2000, text_max_buffer_chars: 8000 } } });
function sttInput() {
  return { apiKey: secret, onPartial: vi.fn<TranscriberInput['onPartial']>(), onFinal: vi.fn<TranscriberInput['onFinal']>(),
    onSpeechStarted: vi.fn<TranscriberInput['onSpeechStarted']>(), onError: vi.fn<TranscriberInput['onError']>() };
}
function ttsInput() {
  return { apiKey: secret, onAudio: vi.fn<SynthesizerInput['onAudio']>(),
    onBoundaries: vi.fn<NonNullable<SynthesizerInput['onBoundaries']>>(), onError: vi.fn<SynthesizerInput['onError']>() };
}
const audio = Buffer.alloc(4800, 2); // Exactly 100 ms of mono PCM16 at 24 kHz.
const audioFrame = { type: 'Audio', audio: audio.toString('base64'), flush_id: 0 };
const flushDone = { type: 'FlushDone', flush_id: 0, audio_duration_ms: 100 };
const boundaries = { type: 'WordBoundaries', flush_id: 0, audio_start_ms: 0,
  words: [{ word: 'Hello.', start: 10, end: 90, confidence: .9 }] };

describe('streaming STT wire protocol', () => {
  it('buffers sub-50ms input and zero-pads only the final ForceEndpoint remainder', async () => {
    const frames: { binary: boolean; data: Buffer }[] = [];
    const p = await provider(socket => {
      send(socket, sttBegin()); socket.on('message', (data, binary) => frames.push({ binary, data: Buffer.from(data as Buffer) }));
    });
    const stt = await createTranscriber(sttInput(), p.dependencies); disposables.push(stt);
    stt.sendAudio(Buffer.alloc(600, 1)); stt.sendAudio(Buffer.alloc(1000, 2)); stt.sendAudio(Buffer.alloc(200, 3));
    stt.forceEndpoint();
    await expect.poll(() => frames.length).toBe(3);
    expect(frames[0]!.data).toEqual(Buffer.concat([Buffer.alloc(600, 1), Buffer.alloc(1000, 2)]));
    expect(frames[1]!.data).toEqual(Buffer.concat([Buffer.alloc(200, 3), Buffer.alloc(1400)]));
    expect(frames[0]!.binary).toBe(true); expect(frames[1]!.binary).toBe(true);
    expect(JSON.parse(frames[2]!.data.toString())).toEqual({ type: 'ForceEndpoint' });
  });

  it('pins PCM/model via header-authenticated URL and sends binary PCM / ForceEndpoint', async () => {
    const frames: { binary: boolean; data: Buffer }[] = [];
    const p = await provider(socket => {
      socket.on('message', (data, binary) => frames.push({ binary, data: Buffer.from(data as Buffer) }));
      send(socket, sttBegin());
    });
    const input = sttInput();
    const stt = await createTranscriber(input, p.dependencies); disposables.push(stt);
    stt.sendAudio(new Uint8Array(1600)); stt.forceEndpoint(); stt.forceEndpoint();
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ binary: true }); expect(frames[0]!.data.length).toBe(1600);
    expect(JSON.parse(frames[1]!.data.toString())).toEqual({ type: 'ForceEndpoint' });
    const [target, options] = p.factory.mock.calls[0]!;
    const url = new URL(target);
    expect(url.origin + url.pathname).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ sample_rate: '16000', encoding: 'pcm_s16le',
      speech_model: 'universal-3-6-pro', session_heartbeat: 'true', min_turn_silence: '400', max_turn_silence: '1600' });
    expect(target).not.toContain(secret);
    expect(options).toMatchObject({ headers: { Authorization: secret }, followRedirects: false, perMessageDeflate: false });
  });

  it('replaces partials, commits a formatted final once and namespaces provider turn identity', async () => {
    let peer!: WebSocket;
    const p = await provider(socket => { peer = socket; send(socket, sttBegin()); });
    const input = sttInput(); const stt = await createTranscriber(input, p.dependencies); disposables.push(stt);
    send(peer, { type: 'SpeechStarted', timestamp: 100, confidence: .9 });
    send(peer, { type: 'SpeechStarted', timestamp: 100, confidence: .9 });
    const turn = { type: 'Turn', turn_order: 0, transcript: 'hello', end_of_turn: false, turn_is_formatted: false };
    send(peer, turn); send(peer, { ...turn, transcript: 'hello world' });
    send(peer, { ...turn, end_of_turn: true });
    send(peer, { ...turn, transcript: 'Hello world.', end_of_turn: true, turn_is_formatted: true });
    send(peer, { ...turn, transcript: 'duplicate', end_of_turn: true, turn_is_formatted: true });
    send(peer, turn);
    send(peer, { type: 'FutureEvent', any: true });
    await expect.poll(() => input.onFinal.mock.calls.length).toBe(1);
    expect(input.onPartial).toHaveBeenCalledTimes(3);
    expect(input.onPartial.mock.calls[1]![0].text).toBe('hello world');
    expect(input.onFinal).toHaveBeenCalledWith({ providerSessionId: 'stt-session', turnId: 'stt-session:0', turnOrder: 0, text: 'Hello world.' });
    expect(input.onSpeechStarted).toHaveBeenCalledExactlyOnceWith({ providerSessionId: 'stt-session', timestampMs: 100 });
    expect(input.onError).not.toHaveBeenCalled();
  });

  it('rejects a different negotiated model before accepting microphone bytes', async () => {
    const p = await provider(socket => send(socket, { ...sttBegin(), configuration: { model: 'wrong-model' } }));
    const input = sttInput();
    await expect(createTranscriber(input, p.dependencies)).rejects.toMatchObject({ code: 'protocol-error' });
    expect(input.onError).toHaveBeenCalledTimes(1);
  });

  it('bounds Begin waiting and closes silent/lost provider connections', async () => {
    const p = await provider(() => undefined);
    const input = sttInput();
    await expect(createTranscriber(input, { ...p.dependencies, connectTimeoutMs: 80 })).rejects.toMatchObject({ code: 'timeout' });
    const q = await provider(socket => send(socket, sttBegin()));
    const other = sttInput(); const stt = await createTranscriber(other, { ...q.dependencies, idleTimeoutMs: 80 }); disposables.push(stt);
    await expect.poll(() => other.onError.mock.calls[0]?.[0].code).toBe('timeout');
    expect(() => stt.sendAudio(new Uint8Array(1600))).toThrow('closed');
  });

  it('rejects malformed PCM without sending it and disconnects an unbounded audio backlog', async () => {
    const p = await provider(socket => send(socket, sttBegin()));
    const input = sttInput(); const stt = await createTranscriber(input, p.dependencies); disposables.push(stt);
    for (const size of [0, 1, 3, 16002]) expect(() => stt.sendAudio(new Uint8Array(size))).toThrow('complete PCM16');
    expect(() => { for (let i = 0; i < 12; i++) stt.sendAudio(new Uint8Array(16000)); }).toThrow('faster');
    expect(input.onError.mock.calls[0]?.[0].code).toBe('backpressure');
  });

  it('aborts pending negotiation and intentional close suppresses subsequent finals', async () => {
    const controller = new AbortController();
    const p = await provider(() => undefined);
    const input = { ...sttInput(), signal: controller.signal };
    const opening = createTranscriber(input, p.dependencies);
    const rejected = expect(opening).rejects.toMatchObject({ code: 'aborted' });
    controller.abort(); await rejected;
    expect(input.onError).not.toHaveBeenCalled();
    let peer!: WebSocket;
    const q = await provider(socket => { peer = socket; send(socket, sttBegin()); });
    const next = sttInput(); const stt = await createTranscriber(next, q.dependencies);
    stt.close();
    send(peer, { type: 'Turn', turn_order: 0, transcript: 'late', end_of_turn: true, turn_is_formatted: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(next.onFinal).not.toHaveBeenCalled(); expect(next.onError).not.toHaveBeenCalled();
  });

  it('limits session lifetime even with a valid long provider expiry', async () => {
    const p = await provider(socket => send(socket, sttBegin()));
    const input = sttInput(); const stt = await createTranscriber(input, { ...p.dependencies, maxSessionMs: 60 }); disposables.push(stt);
    await expect.poll(() => input.onError.mock.calls[0]?.[0].message).toContain('time limit');
  });

  it('never exposes provider Error text or malformed payloads', async () => {
    const p = await provider(socket => send(socket, { type: 'Error', error_code: 3009, error: secret }));
    await expect(createTranscriber(sttInput(), p.dependencies)).rejects.toMatchObject({ code: 'rate-limited' });
    const q = await provider(socket => socket.send(`not JSON ${secret}`));
    const input = sttInput();
    await expect(createTranscriber(input, q.dependencies)).rejects.toMatchObject({ code: 'protocol-error' });
    expect(JSON.stringify(input.onError.mock.calls)).not.toContain(secret);
  });

  it('sanitizes HTTP upgrade rejection and leaves no active socket', async () => {
    const p = await provider(() => undefined, 401);
    const input = sttInput();
    await expect(createTranscriber(input, p.dependencies)).rejects.toMatchObject({ code: 'authentication' });
    const tts = await createSynthesizer(ttsInput(), p.dependencies); disposables.push(tts);
    await expect(tts.speak('Hello.')).rejects.toMatchObject({ code: 'authentication' });
    expect(p.server.clients.size).toBe(0);
    expect(JSON.stringify(input.onError.mock.calls)).not.toContain(secret);
  });
});

describe('streaming TTS wire protocol', () => {
  it('sends the selected language and rejects mismatched negotiation before audio', async () => {
    const p = await provider(socket => send(socket, ttsBegin()));
    const input = { ...ttsInput(), language: 'spanish' as const };
    const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await expect(tts.speak('Hola.')).rejects.toMatchObject({ code: 'protocol-error' });
    expect(new URL(p.factory.mock.calls[0]![0]).searchParams.get('language')).toBe('spanish');
    expect(input.onAudio).not.toHaveBeenCalled();
  });
  it('negotiates 24k PCM and streams JSON/base64 audio; FlushDone precedes boundary drain', async () => {
    const received: Record<string, unknown>[] = []; let peer!: WebSocket;
    const p = await provider(socket => {
      peer = socket; send(socket, ttsBegin());
      socket.on('message', data => {
        const frame = JSON.parse(data.toString()); received.push(frame);
        if (frame.type === 'Flush') { send(socket, audioFrame); send(socket, flushDone); }
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    const onStart = vi.fn(), onDone = vi.fn(); let completed = false;
    const speaking = tts.speak('Hello.', { onStart, onDone }).then(() => { completed = true; });
    await expect.poll(() => received.length).toBe(3);
    expect(received).toEqual([{ type: 'Generate', text: 'Hello.' }, { type: 'Flush' }, { type: 'Terminate' }]);
    expect(onStart).toHaveBeenCalledExactlyOnceWith({ providerSessionId: 'tts-session', flushId: 0 });
    expect(input.onAudio).toHaveBeenCalledExactlyOnceWith(audio, { providerSessionId: 'tts-session', flushId: 0 });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({ providerSessionId: 'tts-session', flushId: 0, audioDurationMs: 100 });
    expect(completed).toBe(false);
    send(peer, boundaries); send(peer, { type: 'Termination' }); await speaking;
    expect(input.onBoundaries).toHaveBeenCalledExactlyOnceWith({ providerSessionId: 'tts-session', flushId: 0, audioStartMs: 0,
      words: [{ word: 'Hello.', startMs: 10, endMs: 90, confidence: .9 }] });
    const [target, options] = p.factory.mock.calls[0]!;
    const url = new URL(target);
    expect(url.origin + url.pathname).toBe('wss://tts.us.assemblyai.com/v1/ws');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model_id: 'assemblyai-tts-1', sample_rate: '24000', encoding: 'pcm_s16le', word_boundaries: 'true', language: 'english' });
    expect(target).not.toContain(secret); expect(options.headers).toEqual({ Authorization: secret });
  });

  it('does not require best-effort word boundaries to complete a valid request', async () => {
    const p = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'Flush') { send(socket, audioFrame); send(socket, flushDone); }
        if (frame.type === 'Terminate') send(socket, { type: 'Termination' });
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await tts.speak('Hello.'); expect(input.onBoundaries).not.toHaveBeenCalled();
  });

  it.each([
    { begin: { word_boundaries: false }, frame: undefined },
    { begin: {}, frame: { ...boundaries, words: [{ word: 'Hello.', start: 10, end: 99999, confidence: .9 }] } },
  ])('keeps audio when word timings are disabled or malformed %#', async ({ begin, frame }) => {
    const p = await provider(socket => {
      send(socket, { ...ttsBegin(), configuration: { ...ttsBegin().configuration, ...begin } }); socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'Flush') { send(socket, audioFrame); send(socket, flushDone); if (frame) send(socket, frame); }
        if (message.type === 'Terminate') send(socket, { type: 'Termination' });
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await tts.speak('Hello.');
    expect(input.onAudio).toHaveBeenCalledTimes(1); expect(input.onBoundaries).not.toHaveBeenCalled(); expect(input.onError).not.toHaveBeenCalled();
  });

  it('drops cancellation tails and uses a new provider namespace for the next reply', async () => {
    const received: string[] = [];
    const p = await provider((socket, index) => {
      send(socket, ttsBegin(`tts-${index}`));
      socket.on('message', data => {
        const frame = JSON.parse(data.toString()); received.push(`${index}:${frame.type}`);
        if (frame.type === 'Flush') { send(socket, audioFrame); if (index > 0) send(socket, flushDone); }
        if (frame.type === 'Cancel') {
          send(socket, audioFrame); send(socket, flushDone); send(socket, boundaries);
          send(socket, { type: 'Cancelled', audio_duration_seconds: .2 });
          send(socket, audioFrame); // Already in transit after acknowledgement must still be dropped.
        }
        if (frame.type === 'Terminate') send(socket, { type: 'Termination' });
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    const first = expect(tts.speak('First.')).rejects.toMatchObject({ code: 'aborted' });
    await expect.poll(() => input.onAudio.mock.calls.length).toBe(1);
    await tts.cancel(); await first;
    expect(input.onAudio).toHaveBeenCalledTimes(1); expect(input.onBoundaries).not.toHaveBeenCalled();
    await tts.speak('Second.');
    expect(input.onAudio).toHaveBeenCalledTimes(2);
    expect(input.onAudio.mock.calls[1]![1]).toEqual({ providerSessionId: 'tts-1', flushId: 0 });
    expect(received).toContain('0:Cancel'); expect(p.factory).toHaveBeenCalledTimes(2);
    expect(input.onError).not.toHaveBeenCalled();
  });

  it('bounds cancellation acknowledgement waiting and serializes a concurrent new speak', async () => {
    const p = await provider((socket, index) => {
      send(socket, ttsBegin(`tts-${index}`)); socket.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'Flush') { send(socket, audioFrame); if (index) send(socket, flushDone); }
        if (frame.type === 'Terminate') send(socket, { type: 'Termination' });
        // Deliberately never acknowledge Cancel.
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, { ...p.dependencies, cancelTimeoutMs: 60 }); disposables.push(tts);
    const first = expect(tts.speak('First.')).rejects.toMatchObject({ code: 'aborted' });
    await expect.poll(() => input.onAudio.mock.calls.length).toBe(1);
    const cancellation = tts.cancel(); const next = tts.speak('Second.');
    await cancellation; await first; await next;
    expect(p.factory).toHaveBeenCalledTimes(2);
  });

  it('cancels before Begin and after FlushDone without accepting late callbacks', async () => {
    const p = await provider(() => undefined);
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    const pending = expect(tts.speak('Hello.')).rejects.toMatchObject({ code: 'aborted' });
    await tts.cancel(); await pending;
    const q = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Flush') { send(socket, audioFrame); send(socket, flushDone); }
      });
    });
    const second = ttsInput(); const other = await createSynthesizer(second, q.dependencies); disposables.push(other);
    const done = vi.fn(); const drain = expect(other.speak('Hello.', { onDone: done })).rejects.toMatchObject({ code: 'aborted' });
    await expect.poll(() => done.mock.calls.length).toBe(1); await other.cancel(); await drain;
    expect(second.onBoundaries).not.toHaveBeenCalled();
  });

  it('rejects overlapping speaks; request AbortSignal cancels only that output', async () => {
    const p = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Cancel') send(socket, { type: 'Cancelled' });
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    const controller = new AbortController();
    const speaking = expect(tts.speak('Hello.', { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    await expect(tts.speak('Overlap.')).rejects.toMatchObject({ code: 'busy' });
    controller.abort(); await speaking;
    const next = expect(tts.speak('Still usable.')).rejects.toMatchObject({ code: 'aborted' });
    tts.close(); await next;
    await expect(tts.speak('Closed.')).rejects.toMatchObject({ code: 'closed' });
  });

  it.each([
    { sample_rate: 16000 }, { encoding: 'mp3' }, { model: 'latest' }, { word_boundaries: 'yes' }, { voice_id: 'wrong' },
  ])('rejects mismatched Begin before text is submitted: %j', async override => {
    const received = vi.fn();
    const p = await provider(socket => {
      socket.on('message', received);
      send(socket, { ...ttsBegin(), configuration: { ...ttsBegin().configuration, ...override } });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await expect(tts.speak('Hello.')).rejects.toMatchObject({ code: 'protocol-error' });
    expect(received).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'Audio', flush_id: 0, audio: 'not base64' },
    { type: 'Audio', flush_id: 0, audio: 'AQ==' },
    { ...audioFrame, flush_id: 1 },
    { type: 'FlushDone', flush_id: 0, audio_duration_ms: 9999 },
  ])('fails closed on malformed/mismatched audio frame %#', async frame => {
    const p = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Flush') send(socket, frame);
      });
    });
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await expect(tts.speak('Hello.')).rejects.toBeInstanceOf(Error);
    expect(input.onAudio).not.toHaveBeenCalled(); expect(input.onError).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid input before opening a socket and honors runtime text limits', async () => {
    const p = await provider(socket => send(socket, { ...ttsBegin(), configuration: { ...ttsBegin().configuration,
      limits: { max_generate_text_length: 4, text_max_buffer_chars: 4 } } }));
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await expect(tts.speak(' ')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(tts.speak('🙂'.repeat(2001))).rejects.toMatchObject({ code: 'invalid-input' });
    expect(p.factory).not.toHaveBeenCalled();
    await expect(tts.speak('🙂'.repeat(5))).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(p.factory).toHaveBeenCalledTimes(1);
  });

  it('bounds missing Begin, incomplete synthesis and incomplete boundary drain', async () => {
    const p = await provider(() => undefined);
    const tts = await createSynthesizer(ttsInput(), { ...p.dependencies, connectTimeoutMs: 60 }); disposables.push(tts);
    await expect(tts.speak('Hello.')).rejects.toMatchObject({ code: 'timeout' });
    const q = await provider(socket => send(socket, ttsBegin()));
    const other = await createSynthesizer(ttsInput(), { ...q.dependencies, requestTimeoutMs: 60 }); disposables.push(other);
    await expect(other.speak('Hello.')).rejects.toMatchObject({ code: 'timeout' });
    const r = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Flush') { send(socket, audioFrame); send(socket, flushDone); }
      });
    });
    const drain = await createSynthesizer(ttsInput(), { ...r.dependencies, idleTimeoutMs: 60 }); disposables.push(drain);
    await expect(drain.speak('Hello.')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('sanitizes provider failures and releases sockets when a consumer callback throws', async () => {
    const p = await provider(socket => send(socket, { type: 'Error', error_code: 3001, error: secret }));
    const input = ttsInput(); const tts = await createSynthesizer(input, p.dependencies); disposables.push(tts);
    await expect(tts.speak('Hello.')).rejects.toMatchObject({ code: 'authentication' });
    expect(JSON.stringify(input.onError.mock.calls)).not.toContain(secret);
    const q = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Flush') send(socket, audioFrame);
      });
    });
    const otherInput = ttsInput(); otherInput.onAudio.mockImplementation(() => { throw new Error(secret); });
    const other = await createSynthesizer(otherInput, q.dependencies); disposables.push(other);
    await expect(other.speak('Hello.')).rejects.toMatchObject({ code: 'protocol-error' });
    expect(JSON.stringify(otherInput.onError.mock.calls)).not.toContain(secret);
  });

  it('rejects binary TTS frames and bounds total decoded PCM output', async () => {
    const p = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Flush') socket.send(audio);
      });
    });
    const tts = await createSynthesizer(ttsInput(), p.dependencies); disposables.push(tts);
    await expect(tts.speak('Hello.')).rejects.toMatchObject({ code: 'protocol-error' });
    const q = await provider(socket => {
      send(socket, ttsBegin()); socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'Flush') {
          const frame = { ...audioFrame, audio: Buffer.alloc(512000).toString('base64') };
          for (let i = 0; i < 12; i++) send(socket, frame);
        }
      });
    });
    const input = ttsInput(); const bounded = await createSynthesizer(input, q.dependencies); disposables.push(bounded);
    await expect(bounded.speak('Hello.')).rejects.toMatchObject({ code: 'audio-too-large' });
    expect(input.onAudio.mock.calls.reduce((sum, call) => sum + call[0].length, 0)).toBeLessThanOrEqual(120 * 24000 * 2);
  });
});
