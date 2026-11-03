// E2E-only entry point. Production server.ts never imports this fixture.
// The app and voice runtime are real; only paid provider factories are replaced.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';
import type { TranscriberInput, SynthesizerInput, SpeakOptions } from '../../packages/speech/src/index.js';

async function main() {
const directory = await mkdtemp(path.join(tmpdir(), 'tokai-voice-e2e-'));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const app = await createApp({
  dataDir: directory, rateLimit: false,
  env: { GEMINI_API_KEY: 'test-gemini-key', GEMINI_MODEL: 'fixture-model', ASSEMBLYAI_API_KEY: 'test-speech-key' },
  tutor: async ({ text, signal }) => {
    await delay(50);
    signal?.throwIfAborted();
    return { text: `Fixture tutor response: ${text}. Sunlight supplies the energy plants use to make sugar.` };
  },
  voice: {
    createTranscriber: async (input: TranscriberInput) => {
      await delay(250); // Exercise microphone buffering while the provider connects.
      const providerSessionId = randomUUID(); let closed = false, chunks = 0, turnOrder = 0;
      return {
        sendAudio() {
          if (closed) return;
          chunks++;
          if (chunks === 2) {
            input.onSpeechStarted({ providerSessionId, timestampMs: Date.now() });
            input.onPartial({ providerSessionId, turnId: `${providerSessionId}:${turnOrder}`, turnOrder, text: 'How does sunlight' });
          }
        },
        forceEndpoint() {
          if (closed || chunks < 2) return;
          const turn = { providerSessionId, turnId: `${providerSessionId}:${turnOrder}`, turnOrder, text: 'How does sunlight help plants?' };
          input.onFinal(turn); input.onFinal(turn); // Duplicate final delivery must never create a second turn.
          chunks = 0; turnOrder++;
        },
        close() { closed = true; }
      };
    },
    createSynthesizer: async (input: SynthesizerInput) => {
      let cancelled = false, closed = false;
      return {
        async speak(_text: string, options: SpeakOptions = {}) {
          cancelled = false;
          const identity = { providerSessionId: randomUUID(), flushId: 0 };
          options.onStart?.(identity);
          // Synthetic quiet 220 Hz tone verifies PCM transport/playback, not speech quality.
          for (let packet = 0; packet < 150; packet++) {
            if (cancelled || closed || options.signal?.aborted) {
              setTimeout(() => input.onAudio(new Uint8Array(960), identity), 30); // Intentional stale provider tail.
              throw new Error('Fixture synthesis cancelled');
            }
            const pcm = new Uint8Array(960), view = new DataView(pcm.buffer);
            for (let i = 0; i < 480; i++) view.setInt16(i * 2, Math.round(Math.sin((packet * 480 + i) * 2 * Math.PI * 220 / 24000) * 600), true);
            input.onAudio(pcm, identity);
            await delay(10);
          }
          options.onDone?.({ ...identity, audioDurationMs: 3000 });
        },
        async cancel() { cancelled = true; },
        close() { closed = true; }
      };
    }
  }
});
await app.listen({ host: '127.0.0.1', port: 4100 });
console.log('Tokai E2E fixture API ready: simulated providers only, port 4100.');
async function shutdown() {
  await app.close();
  const resolved = path.resolve(directory), tempRoot = path.resolve(tmpdir()) + path.sep;
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('tokai-voice-e2e-')) throw new Error('Unexpected fixture cleanup path');
  await rm(resolved, { recursive: true, force: true });
  process.exitCode = 0;
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
}
main().catch(error => { console.error(error); process.exitCode = 1; });
