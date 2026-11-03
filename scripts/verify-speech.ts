import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createSynthesizer, createTranscriber, SpeechError, synthesizeSpeech } from '../packages/speech/src/index.js';

const text = 'Welcome to Tokai. Let us learn one idea together.';

function wave(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Windowed-sinc lowpass for the probe's fixed 24k -> 16k conversion; not browser capture. */
function resampleProbe(pcm: Buffer): Buffer {
  const length = pcm.length / 2, output = Buffer.alloc(Math.floor(length * 2 / 3) * 2);
  for (let i = 0; i < output.length / 2; i++) {
    const position = i * 1.5, centre = Math.floor(position);
    let sum = 0, weightSum = 0;
    for (let sample = centre - 16; sample <= centre + 16; sample++) {
      const distance = position - sample;
      if (Math.abs(distance) > 16) continue;
      const sinc = Math.abs(distance) < 1e-8 ? .6 : Math.sin(Math.PI * .6 * distance) / (Math.PI * distance);
      const weight = sinc * (.5 + .5 * Math.cos(Math.PI * distance / 16));
      sum += pcm.readInt16LE(Math.min(length - 1, Math.max(0, sample)) * 2) * weight; weightSum += weight;
    }
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / weightSum))), i * 2);
  }
  return output;
}

async function streamingProbe(apiKey: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let boundaryWords = 0, interruptController: AbortController | undefined, firstSession: string | undefined;
  let secondSession: string | undefined, cancellationAudioReceived = false;
  const synthesizer = await createSynthesizer({ apiKey,
    onAudio(pcm) {
      if (interruptController) { cancellationAudioReceived = true; interruptController.abort(); }
      else chunks.push(Buffer.from(pcm));
    },
    onBoundaries(frame) { boundaryWords += frame.words.length; },
    onError() { /* speak rejects with the same sanitized error. */ },
  });
  try {
    await synthesizer.speak(text, { onStart(info) { firstSession = info.providerSessionId; } });
    if (!chunks.length) throw new SpeechError('invalid-audio', 'The streaming probe returned no audio.');
    interruptController = new AbortController();
    try {
      await synthesizer.speak('This output is deliberately interrupted to verify cancellation and late-frame isolation.', {
        signal: interruptController.signal, onStart(info) { secondSession = info.providerSessionId; },
      });
      throw new SpeechError('protocol-error', 'The cancellation probe completed without being interrupted.');
    } catch (error) {
      if (!(error instanceof SpeechError) || error.code !== 'aborted' || !cancellationAudioReceived) throw error;
    }
    if (!firstSession || !secondSession || firstSession === secondSession) throw new SpeechError('protocol-error', 'The probe did not establish independent synthesis sessions.');
  } finally { synthesizer.close(); }

  const pcm = Buffer.concat(chunks), captured = resampleProbe(pcm);
  let finalText = '', transcriptionError: SpeechError | undefined;
  const transcriber = await createTranscriber({ apiKey, onPartial() {}, onSpeechStarted() {},
    onFinal(turn) { finalText += turn.text; }, onError(error) { transcriptionError = error; } });
  try {
    // Append silence and pace in real time. Never upload a file-sized backlog to STT.
    const input = Buffer.concat([captured, Buffer.alloc(16000 * 2 * 2)]);
    const started = performance.now();
    for (let offset = 0; offset < input.length; offset += 1600) {
      if (transcriptionError) throw transcriptionError;
      transcriber.sendAudio(input.subarray(offset, Math.min(offset + 1600, input.length)));
      await delay(Math.max(1, started + (offset + 1600) / 32 - performance.now()));
    }
    transcriber.forceEndpoint();
    const deadline = Date.now() + 10_000;
    while (!finalText && !transcriptionError && Date.now() < deadline) await delay(50);
    if (transcriptionError) throw transcriptionError;
    if (!finalText) throw new SpeechError('timeout', 'The streaming probe received no final transcription.');
  } finally { transcriber.close(); }
  console.log(`Streaming protocol probe passed: ${pcm.length} PCM bytes, ${boundaryWords} best-effort word timings, final STT received.`);
  console.log('Cancellation completed locally within its deadline. This does not certify a billing refund or browser playback behavior.');
  return wave(pcm);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (!arguments_.includes('--live')) {
    console.log('No provider call made. Opt in with: pnpm exec tsx scripts/verify-speech.ts --live [--streaming]');
    console.log('--live probes HTTP TTS. --live --streaming probes TTS, cancellation and an STT round trip; both spend provider credits.');
    return;
  }
  if (arguments_.some(value => !['--live', '--streaming'].includes(value)) || new Set(arguments_).size !== arguments_.length) {
    throw new SpeechError('invalid-input', 'Use --live for HTTP or --live --streaming for the streaming probe.');
  }
  const env = new URL('../.env', import.meta.url);
  if (existsSync(env)) process.loadEnvFile(fileURLToPath(env));
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new SpeechError('not-configured', 'Set ASSEMBLYAI_API_KEY in the root .env or process environment before the live probe.');
  const streaming = arguments_.includes('--streaming');
  const parent = new URL('../var/', import.meta.url);
  const directory = new URL('../var/probes/', import.meta.url);
  const file = new URL(streaming ? 'assemblyai-streaming-probe.wav' : 'assemblyai-tts-probe.wav', directory);
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  // Validate each existing ancestor before creating a child, including Windows junctions.
  for (const folder of [parent, directory]) {
    await mkdir(folder).catch((error: unknown) => {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    });
    const pathWithinRoot = relative(root, await realpath(fileURLToPath(folder)));
    if (isAbsolute(pathWithinRoot) || pathWithinRoot === '..' || pathWithinRoot.startsWith('..\\') || pathWithinRoot.startsWith('../')) {
      throw new SpeechError('invalid-input', 'The probe output directory must stay inside the project.');
    }
  }
  // Reserve before spending credits. Exclusive creation also refuses pre-existing symlinks.
  const output = await open(file, 'wx', 0o600);
  let complete = false;
  try {
    const audio = streaming ? await streamingProbe(apiKey) : (await synthesizeSpeech({ apiKey, text })).audio;
    await output.writeFile(audio); complete = true;
    console.log(`Probe recording saved: ${fileURLToPath(file)} (${audio.byteLength} bytes).`);
    console.log('Listen to this file and test browser microphone/playback separately; protocol success is not an audibility or accuracy evaluation.');
  } finally {
    await output.close();
    if (!complete) await unlink(file).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  if (error instanceof SpeechError) console.error(`${error.code}: ${error.message}`);
  else if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    console.error('The named probe recording already exists. Move it deliberately before another live probe.');
  } else console.error('The speech probe failed. Check the server configuration and output directory.');
  process.exitCode = 1;
});
