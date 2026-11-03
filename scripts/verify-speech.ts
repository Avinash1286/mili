import { mkdir, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SpeechError, synthesizeSpeech } from '../packages/speech/src/index.js';

async function main(): Promise<void> {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--live') {
    console.log('No provider call made. Opt in with: pnpm exec tsx scripts/verify-speech.ts --live');
    console.log('This probes HTTP TTS only. Live STT and streaming interruption are not implemented.');
    return;
  }
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new SpeechError('not-configured', 'Set ASSEMBLYAI_API_KEY on the server before running the live probe.');
  const directory = new URL('../var/probes/', import.meta.url);
  const file = new URL('assemblyai-tts-probe.wav', directory);
  await mkdir(directory, { recursive: true });
  // Reserve before spending provider credits; never overwrite an existing recording.
  const output = await open(file, 'wx', 0o600);
  let complete = false;
  try {
    const result = await synthesizeSpeech({ apiKey, text: 'Welcome to Tokai. Let us learn one idea together.' });
    await output.writeFile(result.audio);
    complete = true;
    console.log(`HTTP TTS probe saved: ${fileURLToPath(file)} (${result.audio.byteLength} bytes).`);
    console.log('Listen to the file to validate audibility; saving WAV bytes alone is not a listening test.');
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
