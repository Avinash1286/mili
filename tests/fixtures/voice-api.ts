// E2E-only entry point. Production server.ts never imports this fixture.
// The app and voice runtime are real; only paid provider factories are replaced.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';
import type { TranscriberInput, SynthesizerInput, SpeakOptions } from '../../packages/speech/src/index.js';
import { DELAYED_VISUAL_REQUEST, VISUAL_REQUEST, visualReply } from './teaching.js';
import { SPATIAL_REQUEST, SPATIAL_SEQUENCE_REQUEST, spatialReply } from './spatial.js';
import { resolveSpatialSelection } from '../../packages/contracts/src/index.js';

async function main() {
const directory = await mkdtemp(path.join(tmpdir(), 'tokai-voice-e2e-'));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const app = await createApp({
  dataDir: directory, rateLimit: false,
  env: { GEMINI_API_KEY: 'test-gemini-key', GEMINI_MODEL: 'fixture-model', ASSEMBLYAI_API_KEY: 'test-speech-key' },
  // Explicitly replace the HTTP speech route too, so every fixture path is offline.
  speech: async () => {
    const audio = Buffer.alloc(44 + 4800);
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8);
    audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(4800, 40);
    return { audio, contentType: 'audio/wav' };
  },
  vision: async () => ({ text: 'Fixture crop explanation: the shared drawing connects light energy with sugar production.' }),
  tutor: async ({ text, signal, session, selectedNodeId, selection }) => {
    await delay(text === DELAYED_VISUAL_REQUEST ? 1200 : 50);
    // Deliberately emulate a provider that completes despite cancellation.
    if (text !== DELAYED_VISUAL_REQUEST) signal?.throwIfAborted();
    if (text === VISUAL_REQUEST || text === DELAYED_VISUAL_REQUEST) return visualReply(session);
    if (text === SPATIAL_REQUEST || text === SPATIAL_SEQUENCE_REQUEST) return spatialReply(text === SPATIAL_SEQUENCE_REQUEST);
    if (selection?.spatial) {
      const { model, parts } = resolveSpatialSelection(selection.spatial);
      return { text: `Selected model: ${model.title}. ${parts.map(part => `${part.label}: ${part.description}`).join(' ')}` };
    }
    const selected = session.board.nodes.find(node => node.id === (selection?.shapeIds[0] ?? selectedNodeId));
    if (selected) return { text: `Selected concept: ${selected.label}. ${selected.detail}` };
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
          // Match the real provider: timing metadata arrives after delivery completion.
          const words = _text.split(/\s+/);
          input.onBoundaries?.({ ...identity, audioStartMs: 7000,
            words: [{ word: words[0]!, startMs: 7000, endMs: 7200, confidence: .99 }, { word: words.at(-1)!, startMs: 9400, endMs: 9800, confidence: .99 }] });
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
