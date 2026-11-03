import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLesson, generateTutorReply, TutorError } from '../packages/tutor-core/src/index.js';

async function main() {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--live') {
    console.log('No provider call made. Opt in with: pnpm exec tsx scripts/verify-tutor.ts --live');
    return;
  }
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) throw new TutorError('TUTOR_UNAVAILABLE', 'Set GEMINI_API_KEY and GEMINI_MODEL in the local root .env before running the live probe.');
  const session = createLesson({ id: randomUUID(), topic: 'photosynthesis', mode: 'live', now: new Date().toISOString(), messageId: randomUUID() });
  const started = performance.now();
  const reply = await generateTutorReply({ session, text: 'Explain in one sentence how sunlight helps a plant make sugar, then ask one question.', apiKey, model, signal: AbortSignal.timeout(30000) });
  // Record only metadata; do not log credentials, prompts or generated content.
  console.log(JSON.stringify({ provider: 'Gemini', model, validated: true, characters: reply.text.length, elapsedMs: Math.round(performance.now() - started) }));
  console.log('A validated response is a connectivity check; manually verify teaching quality in the app.');
}

main().catch((error: unknown) => {
  console.error(error instanceof TutorError ? `${error.code}: ${error.message}` : 'Tutor probe failed. Check local configuration and account access.');
  process.exitCode = 1;
});
