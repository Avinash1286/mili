import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { TranscriberInput } from '@milli/speech';
import { createApp } from '../src/app.js';
let app: Awaited<ReturnType<typeof createApp>>, directory: string, url: string, token: string, sessionId: string;
let callbacks: TranscriberInput, close: ReturnType<typeof vi.fn<() => void>>, sendAudio: ReturnType<typeof vi.fn<(audio: Uint8Array) => void>>;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'milli-stream-')); close = vi.fn(); sendAudio = vi.fn();
  app = await createApp({ dataDir: directory, rateLimit: false,
    env: { GEMINI_API_KEY: 'test', GEMINI_MODEL: 'test', ASSEMBLYAI_API_KEY: 'test' },
    learning: { transcriber: async input => { callbacks = input; return { sendAudio, close, forceEndpoint() {
      callbacks.onFinal({ turnId: 's:1', providerSessionId: 's', turnOrder: 1, text: 'And the bulb lights up.' });
    } }; } },
  });
  url = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
  token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
  sessionId = (await app.inject({ method: 'POST', url: '/v1/courses/start', headers: { authorization: `Bearer ${token}` }, payload: { topic: 'circuits', mode: 'live', featured: true } })).json().session.id;
});
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await app.close(); await rm(directory, { recursive: true, force: true }); });
async function connect(auth: string | undefined = token, cookie = false) {
  const socket = new WebSocket(`${url}/v1/dictation-stream`, { origin: 'http://localhost:3000', ...(cookie ? { headers: { cookie: `tokai_session=${token}` } } : {}) }); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const response = next(socket); socket.send(JSON.stringify({ type: 'start', token: cookie ? undefined : auth, sessionId }));
  return { socket, first: await response };
}
function next(socket: WebSocket): Promise<any> { return new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('No stream response')), 4000);
  socket.once('message', raw => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
}); }
it('streams before finish and preserves both sentences of the answer', async () => {
  const { socket, first } = await connect(); expect(first).toEqual({ type: 'ready' });
  socket.send(Buffer.alloc(1600)); await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledOnce());
  callbacks.onFinal({ turnId: 's:0', providerSessionId: 's', turnOrder: 0, text: 'The battery pushes charge.' });
  callbacks.onPartial({ turnId: 's:1', providerSessionId: 's', turnOrder: 1, text: 'And the bulb' });
  const result = next(socket); socket.send(JSON.stringify({ type: 'finish' }));
  expect(await result).toEqual({ type: 'transcript', text: 'The battery pushes charge. And the bulb lights up.' });
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
});
it('rejects another owner before opening the provider', async () => {
  const other = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
  const { first } = await connect(other); expect(first.type).toBe('error'); expect(sendAudio).not.toHaveBeenCalled();
});
it('closes the provider on interruption and rejects oversized audio frames', async () => {
  const { socket } = await connect(); const result = next(socket); socket.send(Buffer.alloc(6400));
  expect((await result).type).toBe('error'); await vi.waitFor(() => expect(close).toHaveBeenCalled());
});



it('accepts the cookie identity resolved by the normal authentication hook', async () => {
  const { first, socket } = await connect(undefined, true);
  expect(first).toEqual({ type: 'ready' }); socket.close();
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
});
it('rejects an untrusted origin before provider work', async () => {
  const result = await app.inject({ method: 'GET', url: '/v1/dictation-stream', headers: { origin: 'https://untrusted.example' } });
  expect(result.statusCode).toBe(403); expect(sendAudio).not.toHaveBeenCalled();
});
