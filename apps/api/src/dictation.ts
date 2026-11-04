import { registerDictationStream } from './dictation-stream.js';
import { DictationRequestSchema } from '@milli/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { StoreError } from '@milli/db';
import { createTranscriber, type Transcriber } from '@milli/speech';
import { principal, parse, type ProductContext } from './product-context.js';
import type { UsageLease } from './usage.js';

export async function registerDictation(app: FastifyInstance, context: ProductContext, origin = context.env.APP_ORIGIN ?? 'http://localhost:3000') {
  const active = new Map<string, AbortController>();
  registerDictationStream(app, context, active, origin);
  app.addHook('onClose', async () => { for (const controller of active.values()) controller.abort(); });
  app.post('/v1/dictation', { bodyLimit: 1300000, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = await principal(request, context.store), input = parse(DictationRequestSchema, request.body);
    const pcm = Buffer.from(input.pcm, 'base64');
    if (!pcm.length || pcm.length % 2 || pcm.length > 16000 * 2 * 30) throw new StoreError(400, 'INVALID_AUDIO', 'Dictation accepts up to 30 seconds of mono PCM16 audio.');
    if (!context.env.ASSEMBLYAI_API_KEY) throw new StoreError(503, 'DICTATION_UNAVAILABLE', 'AssemblyAI speech recognition is unreachable right now. Continue with chat.');
    if (active.has(p.ownerId) || active.size >= 4) throw new StoreError(429, 'DICTATION_BUSY', 'Wait for the current dictation to finish.');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]); active.set(p.ownerId, controller);
    let transcriber: Transcriber | undefined, failure: Error | undefined, lease: UsageLease | undefined, succeeded = false;
    const turns = new Map<number, string>();
    let latestPartialOrder = -1, latestFinalOrder = -1, lastTranscriptAt = 0;
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); }; reply.raw.once('close', disconnect);
    try {
      lease = await context.usage?.begin(p, 'transcription', Math.ceil(pcm.byteLength / 32), { traceId: request.id });
      transcriber = await (context.providers?.transcriber ?? createTranscriber)({ apiKey: context.env.ASSEMBLYAI_API_KEY, signal, onPartial: turn => { latestPartialOrder = Math.max(latestPartialOrder, turn.turnOrder); lastTranscriptAt = Date.now(); }, onFinal: turn => { turns.set(turn.turnOrder, turn.text); latestFinalOrder = Math.max(latestFinalOrder, turn.turnOrder); lastTranscriptAt = Date.now(); }, onSpeechStarted: () => undefined, onError: error => { failure = error; controller.abort(); } });
      for (let offset = 0; offset < pcm.length; offset += 1600) { signal.throwIfAborted(); transcriber.sendAudio(pcm.subarray(offset, Math.min(offset + 1600, pcm.length))); await delay(50, undefined, { signal }); }
      transcriber.forceEndpoint();
      // Wait for the latest formatted turn rather than sleeping two seconds and
      // potentially returning an earlier sentence while the final one is pending.
      const finishDeadline = Date.now() + 5000;
      do {
        await delay(50, undefined, { signal });
        if (turns.size && latestFinalOrder >= latestPartialOrder && Date.now() - lastTranscriptAt >= 300) break;
      } while (Date.now() < finishDeadline);
      if (latestPartialOrder > latestFinalOrder) throw new StoreError(422, 'INCOMPLETE_SPEECH', 'The end of your answer was not finalized. Please try again or type it.');
      if (failure) throw failure;
      await context.store.principalForOwner(p.ownerId);
      const text = [...turns].sort(([a], [b]) => a - b).map(([, text]) => text).join(' ').trim().slice(0, 3000);
      if (!text) throw new StoreError(422, 'NO_SPEECH', 'No clear speech was recognized. Try again or type your answer.');
      succeeded = true;
      return { text };
    } catch (error) { if (error instanceof StoreError) throw error; throw new StoreError(503, 'DICTATION_FAILED', 'AssemblyAI speech recognition is unreachable right now. Continue with chat.'); }
    finally { reply.raw.off('close', disconnect); transcriber?.close(); controller.abort(); active.delete(p.ownerId); await lease?.finish(succeeded, Math.ceil(pcm.byteLength / 32), { audioMs: pcm.byteLength / 32 }); }
  });
}
