import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { decodeAudioFrame, encodeAudioFrame, VoiceServerEventSchema, type VoiceServerEvent, type Session } from '@tokai/contracts';
import type { TranscriberInput, SynthesizerInput, SpeakOptions } from '@tokai/speech';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import type { TutorInput, TutorReply } from '@tokai/tutor-core';

type Received = { events: VoiceServerEvent[]; audio: ReturnType<typeof decodeAudioFrame>[]; ws: WebSocket };
const origin = 'http://localhost:3000';
const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description = 'condition') { for (let i = 0; i < 150; i++) { if (check()) return; await pause(); } throw new Error(`Timed out: ${description}`); }

describe('authenticated live voice protocol', () => {
  let app: FastifyInstance, directory: string, url: string, token: string, session: Session;
  let transcriberInput: TranscriberInput | undefined;
  let synthInput: SynthesizerInput | undefined;
  let closeStt = vi.fn<() => void>(), cancelTts = vi.fn<() => Promise<void>>(async () => undefined);
  let sendAudio = vi.fn<(audio: Uint8Array) => void>(), forceEndpoint = vi.fn<() => void>(), closeTts = vi.fn<() => void>();
  let openInput: () => Promise<void>, openOutput: () => Promise<void>;
  let now: number;
  let tutorBehavior: (input: TutorInput) => Promise<TutorReply>;
  let speakBehavior: (input: SynthesizerInput, text: string, options?: SpeakOptions) => Promise<void>;
  const sockets: WebSocket[] = [];
  const headers = () => ({ authorization: `Bearer ${token}` });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tokai-voice-'));
    transcriberInput = undefined; synthInput = undefined; closeStt = vi.fn(); cancelTts = vi.fn(async () => undefined);
    sendAudio = vi.fn(); forceEndpoint = vi.fn(); closeTts = vi.fn(); openInput = async () => undefined; openOutput = async () => undefined; now = Date.now();
    tutorBehavior = async () => ({ text: 'Light supplies energy. Which material supplies carbon?' });
    speakBehavior = async (input, _text, options) => {
      input.onAudio(new Uint8Array(4800), { providerSessionId: 'tts', flushId: 0 });
      options?.onDone?.({ providerSessionId: 'tts', flushId: 0, audioDurationMs: 100 });
    };
    app = await createApp({ dataDir: directory, rateLimit: false, now: () => now, env: { GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'test-model', ASSEMBLYAI_API_KEY: 'fake-speech' }, tutor: input => tutorBehavior(input), voice: {
      createTranscriber: async input => { transcriberInput = input; await openInput(); return { sendAudio, forceEndpoint, close: closeStt }; },
      createSynthesizer: async input => { synthInput = input; await openOutput(); return { speak: (text, options) => speakBehavior(input, text, options), cancel: cancelTts, close: closeTts }; }
    } });
    url = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
    token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
    session = (await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(), payload: { topic: 'photosynthesis', mode: 'live' } })).json().session;
  });
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function ticket() { const result = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/voice-ticket`, headers: headers() }); expect(result.statusCode).toBe(200); return result.json().ticket as string; }
  async function connect(rawTicket = '', customOrigin = origin): Promise<Received> {
    const ws = new WebSocket(`${url}/v1/voice?ticket=${rawTicket || await ticket()}`, { origin: customOrigin }); sockets.push(ws);
    const result: Received = { events: [], audio: [], ws };
    ws.on('message', (raw, binary) => { if (binary) result.audio.push(decodeAudioFrame(new Uint8Array(raw as Buffer))); else result.events.push(VoiceServerEventSchema.parse(JSON.parse(raw.toString()))); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await until(() => result.events.some(event => event.type === 'session.ready'), 'ready'); return result;
  }
  const send = (client: Received, event: object) => client.ws.send(JSON.stringify(event));
  async function rejected(rawTicket: string, customOrigin = origin) {
    const ws = new WebSocket(`${url}/v1/voice?ticket=${rawTicket}`, { origin: customOrigin }); sockets.push(ws);
    return new Promise<number>((resolve, reject) => { ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); }); ws.on('open', () => reject(new Error('Unexpected connection'))); ws.on('error', () => undefined); });
  }
  it('enforces ownership, Origin, one-use tickets and one active guest connection', async () => {
    const b = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/voice-ticket`, headers: { authorization: `Bearer ${b}` } })).statusCode).toBe(404);
    const raw = await ticket(); expect(await rejected(raw, 'https://evil.example')).toBe(403);
    expect((await app.inject({ url: `/v1/voice?ticket=${raw}`, headers: { origin } })).statusCode).toBe(400);
    const client = await connect(raw);
    expect(await rejected(raw)).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/voice-ticket`, headers: headers() })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'HTTP race' } })).statusCode).toBe(409);
    send(client, { type: 'heartbeat' }); await until(() => client.events.some(event => event.type === 'heartbeat'));
  });
  it('expires tickets and rejects sample-mode voice', async () => {
    const raw = await ticket(); now += 31000; expect(await rejected(raw)).toBe(401);
    const sample = (await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(), payload: { topic: 'fractions', mode: 'sample' } })).json().session as Session;
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${sample.id}/voice-ticket`, headers: headers() })).statusCode).toBe(409);
  });
  it('deduplicates text durably across reconnect and only marks complete after playback ACK', async () => {
    const client = await connect();
    send(client, { type: 'input.text', requestId: 'r1', text: 'Why light?' });
    await until(() => client.events.some(event => event.type === 'audio.end'));
    send(client, { type: 'input.text', requestId: 'r1', text: 'Why light?' }); await pause(50);
    let current = (await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session as Session;
    expect(current.messages.filter(message => message.role === 'student')).toHaveLength(1);
    expect(current.messages.at(-1)?.delivery).toBe('generated');
    const start = client.events.find(event => event.type === 'audio.start')!;
    if (start.type !== 'audio.start') throw new Error('Missing audio start');
    send(client, { type: 'playback.ack', outputEpoch: start.outputEpoch, streamId: start.streamId, playedSamples: 2400, status: 'completed' });
    await until(() => client.events.some(event => event.type === 'session.snapshot' && event.session.messages.at(-1)?.delivery === 'completed'));
    client.ws.close(); await until(() => client.ws.readyState === WebSocket.CLOSED); await pause(40);
    const reconnected = await connect();
    expect(reconnected.audio).toHaveLength(0);
    expect(reconnected.events[0]!.connectionId).not.toBe(client.events[0]!.connectionId);
    send(reconnected, { type: 'input.text', requestId: 'r1', text: 'Why light?' }); await pause(70);
    current = (await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session;
    expect(current.messages.filter(message => message.role === 'student')).toHaveLength(1);
    expect(reconnected.audio).toHaveLength(0);
  });
  it('cancels a pending model without blocking the session lock or committing stale output', async () => {
    const client = await connect(); let resolve!: (value: TutorReply) => void; let input!: TutorInput;
    tutorBehavior = value => { input = value; return new Promise(done => { resolve = done; }); };
    send(client, { type: 'input.text', requestId: 'pending', text: 'A long explanation' });
    await until(() => Boolean(input));
    const epoch = client.events.at(-1)!.outputEpoch;
    send(client, { type: 'input.interrupt', outputEpoch: epoch, reason: 'control' });
    await until(() => input.signal!.aborted);
    resolve({ text: 'This obsolete response must disappear.' }); await pause(60);
    expect(client.events.filter(event => event.type === 'tutor.beat')).toHaveLength(0);
    expect((await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session.messages).toHaveLength(2);
  });
  it('does not let a delayed replay acquire a newer text generation epoch', async () => {
    const client = await connect(); let release!: () => void; let opening = 0;
    openOutput = async () => { if (++opening === 1) await new Promise<void>(resolve => { release = resolve; }); };
    const spoken: string[] = [];
    speakBehavior = async (input, text, options) => { spoken.push(text); input.onAudio(new Uint8Array(4800), { providerSessionId: 'tts', flushId: 0 }); options?.onDone?.({ providerSessionId: 'tts', flushId: 0, audioDurationMs: 100 }); };
    send(client, { type: 'input.repeat', messageId: session.messages[0]!.id }); await until(() => Boolean(release));
    tutorBehavior = async () => ({ text: 'Only the new explanation should be spoken.' });
    send(client, { type: 'input.text', requestId: 'newer', text: 'Newer question' });
    await until(() => client.events.some(event => event.type === 'audio.end'));
    release(); await pause(60);
    expect(spoken).toEqual(['Only the new explanation should be spoken.']);
  });
  it('drops late PCM after interruption and stores played duration without replay', async () => {
    const client = await connect(); let complete!: () => void;
    speakBehavior = async input => { input.onAudio(new Uint8Array(4800), { providerSessionId: 'tts', flushId: 0 }); await new Promise<void>(resolve => { complete = resolve; }); };
    send(client, { type: 'input.text', requestId: 'audio', text: 'Explain the Sun' });
    await until(() => client.audio.length > 0);
    const start = client.events.find(event => event.type === 'audio.start')!;
    if (start.type !== 'audio.start') throw new Error('Missing start');
    send(client, { type: 'playback.ack', outputEpoch: start.outputEpoch, streamId: start.streamId, playedSamples: 1200, status: 'interrupted' });
    send(client, { type: 'input.interrupt', outputEpoch: start.outputEpoch });
    await until(() => client.events.some(event => event.type === 'audio.cancel' && event.outputEpoch > start.outputEpoch));
    const before = client.audio.length;
    synthInput!.onAudio(new Uint8Array(4800), { providerSessionId: 'tts', flushId: 0 }); complete(); await pause(60);
    expect(client.audio).toHaveLength(before);
    const saved = (await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session as Session;
    expect(saved.messages.at(-1)?.delivery).toBe('interrupted'); expect(saved.messages.at(-1)?.playedMs).toBe(50);
  });
  it('bounds queued playback to four seconds until ACK credits arrive', async () => {
    speakBehavior = async (input, _text, options) => { input.onAudio(new Uint8Array(24000 * 2 * 6), { providerSessionId: 'tts', flushId: 0 }); options?.onDone?.({ providerSessionId: 'tts', flushId: 0, audioDurationMs: 6000 }); };
    const client = await connect(); send(client, { type: 'input.text', requestId: 'pace', text: 'Explain slowly' });
    await until(() => client.audio.reduce((sum, frame) => sum + frame.samples.length, 0) === 96000);
    expect(client.events.some(event => event.type === 'audio.end')).toBe(false);
    const start = client.events.find(event => event.type === 'audio.start')!;
    if (start.type !== 'audio.start') throw new Error('Missing start');
    send(client, { type: 'playback.ack', outputEpoch: start.outputEpoch, streamId: start.streamId, playedSamples: 48000, status: 'progress' });
    await until(() => client.events.some(event => event.type === 'audio.end'));
    expect(client.audio.reduce((sum, frame) => sum + frame.samples.length, 0)).toBe(144000);
  });
  it('replaces partials without tutor calls, deduplicates finals, and releases input on pause', async () => {
    const client = await connect(); send(client, { type: 'input.audio.start', streamId: 1 }); await until(() => Boolean(transcriberInput));
    const turn = { turnId: 'provider:0', providerSessionId: 'provider', turnOrder: 0, text: 'carbon' };
    transcriberInput!.onPartial(turn); transcriberInput!.onPartial({ ...turn, text: 'carbon dioxide' }); await pause(30);
    expect(client.events.filter(event => event.type === 'tutor.beat')).toHaveLength(0);
    transcriberInput!.onFinal({ ...turn, text: 'carbon dioxide' }); transcriberInput!.onFinal({ ...turn, text: 'carbon dioxide' });
    await until(() => client.events.some(event => event.type === 'audio.end'));
    const saved = (await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session as Session;
    expect(saved.messages.filter(message => message.role === 'student')).toHaveLength(1);
    send(client, { type: 'session.pause' }); await until(() => closeStt.mock.calls.length > 0);
    transcriberInput!.onFinal({ ...turn, turnId: 'provider:1', text: 'stale' }); await pause(30);
    expect((await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session.messages.filter((message: { role: string }) => message.role === 'student')).toHaveLength(1);
  });
  it('acknowledges delayed microphone startup, receives frames before endpoint, and closes after its final', async () => {
    let begin!: () => void; openInput = () => new Promise(resolve => { begin = resolve; });
    const client = await connect(); send(client, { type: 'input.audio.start', streamId: 7 }); await until(() => Boolean(begin));
    expect(client.events.some(event => event.type === 'input.ready')).toBe(false);
    begin(); await until(() => client.events.some(event => event.type === 'input.ready' && event.streamId === 7));
    client.ws.send(encodeAudioFrame({ kind: 'input', streamId: 7, outputEpoch: 0, seq: 0, sampleRate: 16000, samples: new Int16Array(800) }));
    send(client, { type: 'input.audio.end' }); await until(() => forceEndpoint.mock.calls.length === 1);
    expect(sendAudio).toHaveBeenCalledOnce(); expect(sendAudio.mock.invocationCallOrder[0]).toBeLessThan(forceEndpoint.mock.invocationCallOrder[0]!);
    transcriberInput!.onFinal({ turnId: 'delayed:0', providerSessionId: 'delayed', turnOrder: 0, text: 'Sunlight' });
    await until(() => closeStt.mock.calls.length === 1); await until(() => client.events.some(event => event.type === 'audio.end'));
  });
  it('preserves early endpoint and discards a microphone final after switching to typed input', async () => {
    let begin!: () => void; openInput = () => new Promise(resolve => { begin = resolve; });
    const client = await connect(); send(client, { type: 'input.audio.start', streamId: 1 }); await until(() => Boolean(begin));
    send(client, { type: 'input.audio.end' }); await pause(30); begin();
    await until(() => forceEndpoint.mock.calls.length === 1);
    expect(client.events.some(event => event.type === 'input.ready')).toBe(false);
    send(client, { type: 'input.text', requestId: 'typed', text: 'My typed question' }); await until(() => closeStt.mock.calls.length === 1);
    transcriberInput!.onFinal({ turnId: 'old:0', providerSessionId: 'old', turnOrder: 0, text: 'obsolete spoken question' });
    await until(() => client.events.some(event => event.type === 'audio.end'));
    const saved = (await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session as Session;
    expect(saved.messages.filter(message => message.role === 'student').map(message => message.text)).toEqual(['My typed question']);
  });
  it('cancels failed speech output and closes its synthesizer while retaining readable text', async () => {
    speakBehavior = async input => { input.onAudio(new Uint8Array(4800), { providerSessionId: 'failed', flushId: 0 }); throw new Error('provider secret should not leak'); };
    const client = await connect(); send(client, { type: 'input.text', requestId: 'failure', text: 'Explain light' });
    await until(() => client.events.some(event => event.type === 'error' && event.code === 'TTS_FAILED'));
    expect(client.events.some(event => event.type === 'audio.cancel' && event.reason === 'Tutor speech failed')).toBe(true);
    expect(closeTts).toHaveBeenCalledOnce(); expect(cancelTts).toHaveBeenCalled();
    const saved = (await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).json().session as Session;
    expect(saved.messages.at(-1)?.delivery).toBe('failed'); expect(saved.messages.at(-1)?.text).toContain('Light');
    expect(JSON.stringify(client.events)).not.toContain('provider secret');
  });
  it('rejects invalid audio and closes ownership before deletion', async () => {
    const client = await connect(); client.ws.send(encodeAudioFrame({ kind: 'input', streamId: 1, outputEpoch: 1, seq: 0, sampleRate: 16000, samples: new Int16Array(800) }));
    await until(() => client.events.some(event => event.type === 'error' && event.code === 'AUDIO_NOT_READY'));
    expect((await app.inject({ method: 'DELETE', url: `/v1/sessions/${session.id}`, headers: headers() })).statusCode).toBe(204);
    await until(() => client.ws.readyState === WebSocket.CLOSED);
    expect((await app.inject({ url: `/v1/sessions/${session.id}`, headers: headers() })).statusCode).toBe(404);
  });
});
