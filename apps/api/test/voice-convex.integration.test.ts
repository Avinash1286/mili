import { describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ConvexStore } from '@tokai/db';
import { TeachingBeatProposalSchema, type VoiceServerEvent, type Session } from '@tokai/contracts';
import { createApp } from '../src/app.js';
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await pause(); } throw new Error('Timed out waiting for the persisted voice event.'); }
describe.skipIf(process.env.TOKAI_TEST_CONVEX !== '1')('actual Convex across two voice API processes', () => {
  it('consumes tickets across instances and commits visual/audio delivery before rotating to a fresh snapshot', async () => {
    loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url)));
    let now = Date.now();
    const env = { ...process.env, GEMINI_API_KEY: 'injected-fixture', GEMINI_MODEL: 'injected-fixture', ASSEMBLYAI_API_KEY: 'injected-fixture', TOKAI_NATIVE_AUTH: '0', APP_ORIGIN: 'http://localhost:3000' };
    const first = ConvexStore.fromEnv(env), second = ConvexStore.fromEnv(env);
    const options = { env, rateLimit: false, now: () => now, tutor: async ({ session }: { session: Session }) => session.messages.length ? { text: 'Light supplies energy.', beats: [TeachingBeatProposalSchema.parse({ spokenText: 'Light supplies energy.', displayText: 'Light supplies energy.', boardCommands: [{ type: 'upsert_node', node: { id: 'cross-api-energy', label: 'Energy', detail: 'Stored through the second API', kind: 'concept', x: 200, y: 700 } }] })] } : { text: 'What do you know about photosynthesis?' }, voice: {
      rotateAfterMs: 240000,
      createTranscriber: async () => { throw new Error('This test must not open transcription.'); },
      createSynthesizer: async (input: any) => ({ speak: async (_text: string, options: any) => { input.onAudio(new Uint8Array(4800), { providerSessionId: 'fixture', flushId: 0 }); options?.onDone?.({ providerSessionId: 'fixture', flushId: 0, audioDurationMs: 100 }); }, cancel: async () => {}, close: () => {} }),
    } };
    const a = await createApp({ ...options, store: first }), b = await createApp({ ...options, store: second });
    const aUrl = (await a.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:'), bUrl = (await b.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
    const guest = await first.createGuest(), p = await first.authenticate(guest.token), headers = { authorization: `Bearer ${guest.token}` }, sockets: WebSocket[] = [];
    try {
      const created = await a.inject({ method: 'POST', url: '/v1/sessions', headers, payload: { topic: 'photosynthesis', mode: 'live' } }); expect(created.statusCode).toBe(201); const lesson = created.json().session as Session;
      const issue = async () => { const value = await a.inject({ method: 'POST', url: `/v1/sessions/${lesson.id}/voice-ticket`, headers }); expect(value.statusCode).toBe(200); return value.json().ticket; };
      const connect = async (url: string, ticket: string) => {
        const ws = new WebSocket(`${url}/v1/voice?ticket=${ticket}`, { origin: env.APP_ORIGIN }); sockets.push(ws); const events: VoiceServerEvent[] = []; let audio = 0;
        ws.on('message', (raw, binary) => { if (binary) audio++; else events.push(JSON.parse(raw.toString())); });
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); await until(() => events.some(event => event.type === 'session.ready')); return { ws, events, audio: () => audio };
      };
      const ticket = await issue(), connected = await connect(bUrl, ticket);
      const reused = new WebSocket(`${aUrl}/v1/voice?ticket=${ticket}`, { origin: env.APP_ORIGIN }); sockets.push(reused);
      const status = await new Promise<number>(resolve => { reused.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); }); reused.on('error', () => {}); }); expect(status).toBe(401);
      connected.ws.send(JSON.stringify({ type: 'input.text', requestId: 'durable-cross-api-turn', text: 'Show the energy step.' }));
      await until(() => connected.events.some(event => event.type === 'board.patch' && event.beatId));
      const patch = connected.events.find(event => event.type === 'board.patch' && event.beatId)!; if (patch.type !== 'board.patch') throw new Error('Missing patch');
      // A WS publication must already be readable through the other API/store.
      expect((await first.get(p, lesson.id)).board.nodes.some(node => node.id === 'cross-api-energy')).toBe(true);
      connected.ws.send(JSON.stringify({ type: 'board.ready', beatId: patch.beatId, boardRevision: patch.board.revision, outputEpoch: patch.outputEpoch }));
      await until(() => connected.events.some(event => event.type === 'audio.end'));
      const start = connected.events.find(event => event.type === 'audio.start')!; if (start.type !== 'audio.start') throw new Error('Missing audio');
      connected.ws.send(JSON.stringify({ type: 'playback.ack', outputEpoch: start.outputEpoch, streamId: start.streamId, playedSamples: 2400, status: 'completed' }));
      await until(() => connected.events.some(event => event.type === 'session.snapshot' && event.session.messages.some(message => message.turnId === 'text:durable-cross-api-turn' && message.role === 'tutor' && message.delivery === 'completed')));
      const closed = new Promise<number>(resolve => connected.ws.once('close', code => resolve(code))); now += 240001; expect(await closed).toBe(1012);
      now = Date.now(); // The real database independently enforces a <=60-second ticket expiry.
      const resumed = await connect(aUrl, await issue()), ready = resumed.events.find(event => event.type === 'session.ready')!;
      expect(ready.type === 'session.ready' && ready.session.board.nodes.some(node => node.id === 'cross-api-energy')).toBe(true); expect(resumed.audio()).toBe(0);
      expect(ready.outputEpoch).not.toBe(patch.outputEpoch);
    } finally { for (const socket of sockets) socket.terminate(); await a.close(); await b.close(); await first.deleteOwner(p); }
  }, 90000);
});
