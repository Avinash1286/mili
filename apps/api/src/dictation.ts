import { DictationRequestSchema } from '@tokai/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { StoreError } from '@tokai/db';
import { createTranscriber, type Transcriber } from '@tokai/speech';
import { principal, parse, type ProductContext } from './product-context.js';
import type { UsageLease } from './usage.js';

export async function registerDictation(app: FastifyInstance, context: ProductContext) {
  const active = new Map<string, AbortController>();
  app.addHook('onClose', async () => { for (const controller of active.values()) controller.abort(); });
  app.post('/v1/dictation', { bodyLimit: 1300000, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = await principal(request, context.store), input = parse(DictationRequestSchema, request.body);
    const pcm = Buffer.from(input.pcm, 'base64');
    if (!pcm.length || pcm.length % 2 || pcm.length > 16000 * 2 * 30) throw new StoreError(400, 'INVALID_AUDIO', 'Dictation accepts up to 30 seconds of mono PCM16 audio.');
    if (!context.env.ASSEMBLYAI_API_KEY) throw new StoreError(503, 'DICTATION_UNAVAILABLE', 'Speech recognition is not configured. You can type your answer.');
    if (active.has(p.ownerId) || active.size >= 4) throw new StoreError(429, 'DICTATION_BUSY', 'Wait for the current dictation to finish.');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]); active.set(p.ownerId, controller);
    let transcriber: Transcriber | undefined, failure: Error | undefined, lease: UsageLease | undefined, succeeded = false;
    const turns = new Map<number, string>();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); }; reply.raw.once('close', disconnect);
    try {
      lease = await context.usage?.begin(p, 'transcription', Math.ceil(pcm.byteLength / 32), { traceId: request.id });
      transcriber = await (context.providers?.transcriber ?? createTranscriber)({ apiKey: context.env.ASSEMBLYAI_API_KEY, signal, onPartial: () => undefined, onFinal: turn => { turns.set(turn.turnOrder, turn.text); }, onSpeechStarted: () => undefined, onError: error => { failure = error; controller.abort(); } });
      for (let offset = 0; offset < pcm.length; offset += 1600) { signal.throwIfAborted(); transcriber.sendAudio(pcm.subarray(offset, Math.min(offset + 1600, pcm.length))); await delay(50, undefined, { signal }); }
      transcriber.forceEndpoint(); await delay(2000, undefined, { signal });
      if (failure) throw failure;
      await context.store.principalForOwner(p.ownerId);
      const text = [...turns].sort(([a], [b]) => a - b).map(([, text]) => text).join(' ').trim().slice(0, 3000);
      if (!text) throw new StoreError(422, 'NO_SPEECH', 'No clear speech was recognized. Try again or type your answer.');
      succeeded = true;
      return { text };
    } catch (error) { if (error instanceof StoreError) throw error; throw new StoreError(503, 'DICTATION_FAILED', 'Speech recognition did not complete. Your typed text is still available.'); }
    finally { reply.raw.off('close', disconnect); transcriber?.close(); controller.abort(); active.delete(p.ownerId); await lease?.finish(succeeded, Math.ceil(pcm.byteLength / 32), { audioMs: pcm.byteLength / 32 }); }
  });
}
