import type { FastifyInstance } from 'fastify';
import { DictationStreamClientSchema } from '@milli/contracts';
import { createTranscriber, type Transcriber } from '@milli/speech';
import { StoreError, type Principal } from '@milli/db';
import type { ProductContext } from './product-context.js';
import type { UsageLease } from './usage.js';

/** Authenticated, single-utterance relay. Credentials never enter URLs or logs. */
export function registerDictationStream(app: FastifyInstance, context: ProductContext,
  active: Map<string, AbortController>, origin: string) {
  const sockets = new Set<import('ws').WebSocket>();
  app.addHook('onClose', async () => { for (const socket of sockets) socket.close(1001); });
  app.get('/v1/dictation-stream', {
    websocket: true,
    preValidation: async request => {
      if (request.headers.origin !== origin) throw new StoreError(403, 'ORIGIN_REJECTED', 'Origin not allowed.');
      if (sockets.size >= 8) throw new StoreError(429, 'DICTATION_BUSY', 'Voice input is busy. Try again shortly.');
    },
  }, (socket, request) => {
    sockets.add(socket);
    const controller = new AbortController();
    let principal: Principal | undefined, transcriber: Transcriber | undefined, lease: UsageLease | undefined;
    let started = false, ready = false, finished = false, closed = false, succeeded = false, byteCount = 0;
    let partialOrder = -1, finalOrder = -1, lastTextAt = 0, finishAt = 0;
    const turns = new Map<number, string>();
    let polling: ReturnType<typeof setInterval> | undefined;
    const send = (value: object) => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
    const cleanup = async () => {
      if (closed) return;
      closed = true; clearTimeout(authTimer); clearTimeout(lifetime); if (polling) clearInterval(polling);
      controller.abort(); transcriber?.close(); sockets.delete(socket);
      if (principal && active.get(principal.ownerId) === controller) active.delete(principal.ownerId);
      try { await lease?.finish(succeeded, Math.ceil(byteCount / 32), { audioMs: byteCount / 32 }); }
      catch { app.log.warn('Dictation usage settlement failed'); }
    };
    const fail = (message: string) => {
      if (closed) return;
      send({ type: 'error', message }); socket.close(1000); void cleanup();
    };
    const authTimer = setTimeout(() => fail('Voice input authentication timed out.'), 5000);
    const lifetime = setTimeout(() => fail('Voice input timed out. Please try again.'), 45000);
    socket.on('close', () => { void cleanup(); });
    socket.on('error', () => { void cleanup(); });
    socket.on('message', (raw, binary) => {
      if (closed) return;
      if (binary) {
        const pcm = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (!ready || finished || !pcm.length || pcm.length % 2 || pcm.length > 3200 || byteCount + pcm.length > 960000) {
          fail('Voice input exceeded its audio limit. Please try a shorter answer.'); return;
        }
        byteCount += pcm.length;
        try { transcriber!.sendAudio(pcm); } catch { fail('Voice input could not be sent. Please try again.'); }
        return;
      }
      let parsed;
      try { parsed = DictationStreamClientSchema.safeParse(JSON.parse(raw.toString())); } catch { fail('Invalid voice input message.'); return; }
      if (!parsed.success) { fail('Invalid voice input message.'); return; }
      if (parsed.data.type === 'start') {
        if (started) { fail('Voice input already started.'); return; }
        started = true;
        const input = parsed.data;
        void (async () => {
          // The identity hook resolves signed-in cookies into this header.
          const authorization = request.headers.authorization;
          principal = await context.store.authenticate(authorization?.startsWith('Bearer ') ? authorization.slice(7) : input.token);
          const session = await context.store.get(principal, input.sessionId);
          if (session.mode !== 'live') throw new StoreError(409, 'SAMPLE_MODE', 'Voice is disabled in offline sample mode.');
          if (closed) return;
          if (!context.env.ASSEMBLYAI_API_KEY) throw new StoreError(503, 'DICTATION_UNAVAILABLE', 'Speech recognition is not configured.');
          if (active.has(principal.ownerId) || active.size >= 4) throw new StoreError(429, 'DICTATION_BUSY', 'Wait for the current voice input to finish.');
          active.set(principal.ownerId, controller); clearTimeout(authTimer);
          lease = await context.usage?.begin(principal, 'transcription', 30000);
          if (closed) { await lease?.finish(false, 0); return; }
          transcriber = await (context.providers?.transcriber ?? createTranscriber)({ apiKey: context.env.ASSEMBLYAI_API_KEY, signal: controller.signal,
            onPartial: turn => { partialOrder = Math.max(partialOrder, turn.turnOrder); lastTextAt = Date.now(); },
            onFinal: turn => { turns.set(turn.turnOrder, turn.text); finalOrder = Math.max(finalOrder, turn.turnOrder); lastTextAt = Date.now(); },
            onSpeechStarted: () => undefined, onError: () => fail('Speech recognition was interrupted. Please try again.'),
          });
          if (closed) { transcriber.close(); return; }
          ready = true; send({ type: 'ready' });
        })().catch(error => fail(error instanceof StoreError ? error.message : 'Speech recognition could not connect. Please try again.'));
      } else {
        if (!ready || finished) { fail('Voice input is not ready.'); return; }
        finished = true; finishAt = Date.now();
        try { transcriber!.forceEndpoint(); } catch { fail('Speech recognition could not finish.'); return; }
        polling = setInterval(() => {
          if (closed) return;
          const complete = turns.size > 0 && finalOrder >= partialOrder && Date.now() - lastTextAt >= 300 && Date.now() - finishAt >= 300;
          if (!complete && Date.now() - finishAt < 5000) return;
          if (polling) clearInterval(polling);
          if (!complete) { fail('I did not catch your complete answer. Please try again or type it.'); return; }
          void context.store.principalForOwner(principal!.ownerId).then(() => {
            if (closed) return;
            const text = [...turns].sort(([a], [b]) => a - b).map(([, value]) => value).join(' ').trim().slice(0, 3000);
            if (!text) { fail('No clear speech was recognized.'); return; }
            succeeded = true; send({ type: 'transcript', text }); socket.close(1000); void cleanup();
          }).catch(() => fail('Your access expired. Please reload the lesson.'));
        }, 50);
      }
    });
  });
}
