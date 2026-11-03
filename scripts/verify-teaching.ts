import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createLesson, generateTutorReply, TutorError, validateTeachingPlan } from '../packages/tutor-core/src/index.js';

function diagnosticMetadata(diagnostics?: TutorError['diagnostics']) {
  const knownTools = new Set(['draw_shapes', 'edit_shapes', 'highlight_concepts', 'update_mind_map', 'set_lesson_focus', 'submit_teaching_beat']);
  const label = (value: string | undefined) => value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
  return {
    modelCalls: diagnostics?.modelCalls ?? null, toolCalls: diagnostics?.toolCalls ?? null,
    tools: diagnostics?.tools.filter(tool => knownTools.has(tool)).slice(0, 8) ?? [],
    repairAttempts: diagnostics?.repairAttempts ?? null, textOnlyFallback: diagnostics?.textOnlyFallback ?? null,
    rejectedTools: diagnostics?.rejectedTools.slice(0, 8).map(value => ({
      tool: knownTools.has(value.tool) ? value.tool : 'unavailable', code: label(value.code),
      issues: value.issues?.slice(0, 6).map(issue => ({
        path: /^[A-Za-z0-9_.$\[\]?]{1,200}$/.test(issue.path) ? issue.path : null,
        code: /^[a-z][a-z0-9_]{0,49}$/.test(issue.code) ? issue.code : null,
      })) ?? [],
    })) ?? [],
    lastFinishReason: label(diagnostics?.lastFinishReason),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('No provider call made. Opt in with: pnpm exec tsx scripts/verify-teaching.ts --live [--rounds=2]');
    console.log('The live probe defaults to one Gemini request. --rounds=2 explicitly permits one tool-result follow-up. No repairs or speech requests.');
    return;
  }
  if (!args.includes('--live') || args.some(arg => !['--live', '--rounds=2'].includes(arg)) || new Set(args).size !== args.length) {
    throw new TutorError('INVALID_PROBE_ARGUMENTS', 'Use --live, optionally with --rounds=2, to opt into the bounded teaching probe.');
  }
  const maxModelCalls = args.includes('--rounds=2') ? 2 : 1;
  try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL;
  if (!apiKey || !model) throw new TutorError('TUTOR_UNAVAILABLE', 'Set GEMINI_API_KEY and GEMINI_MODEL in the local root .env before the live probe.');
  const session = createLesson({ id: randomUUID(), topic: 'photosynthesis', mode: 'live', now: new Date().toISOString(), messageId: randomUUID() });
  const started = performance.now();
  const reply = await generateTutorReply({
    session, apiKey, model,
    text: `Call draw_shapes to add a small process diagram with two new objects: sunlight energy and sugar production. Use stable IDs probe-light and probe-sugar and the current board revision. Then call submit_teaching_beat to explain the diagram in one short sentence and ask one question. ${maxModelCalls === 1 ? 'Submit both tool calls in this same response; this probe permits only one model response.' : 'Use the same response when possible; this probe permits at most one follow-up to consume the drawing tool result and submit the beat.'} Do not call any external service or update mastery.`,
    signal: AbortSignal.timeout(30_000), limits: { maxModelCalls, maxRepairAttempts: 0 },
  });
  const diagnostics = reply.diagnostics;
  console.log(JSON.stringify({ provider: 'Gemini', maxModelCalls, ...diagnosticMetadata(diagnostics), warningsCount: reply.warnings?.length ?? 0,
    beats: reply.beats?.length ?? 0, elapsedMs: Math.round(performance.now() - started) }));
  if (!diagnostics || diagnostics.modelCalls < 1 || diagnostics.modelCalls > maxModelCalls || diagnostics.repairAttempts !== 0
      || diagnostics.textOnlyFallback || !diagnostics.tools.includes('draw_shapes')
      || !diagnostics.tools.includes('submit_teaching_beat') || !reply.beats?.length) {
    throw new TutorError('TEACHING_PROBE_INCOMPLETE', 'The bounded probe did not return an accepted visual teaching beat. No automatic repair or retry was made.');
  }
  // Pure validation applies all proposed board/map changes to clones. No lesson is persisted.
  const beats = validateTeachingPlan(session, reply.beats);
  const commands = beats.reduce((count, beat) => count + beat.boardCommands.length, 0);
  if (!commands || reply.warnings?.length) {
    throw new TutorError('TEACHING_PROBE_INCOMPLETE', 'The proposed visuals were absent or partially rejected. No automatic retry was made.');
  }
  // Metadata only: never print prompts, generated text, tool arguments, credentials or raw provider errors.
  console.log(JSON.stringify({ provider: 'Gemini', validated: true, modelCalls: diagnostics.modelCalls,
    toolCalls: diagnostics.toolCalls, beats: beats.length, boardCommands: commands,
    mapUpdates: beats.filter(beat => beat.mapUpdate).length, elapsedMs: Math.round(performance.now() - started) }));
  console.log('Structured tools validated against a temporary lesson within the explicit request limit. No speech request, file write, or saved-session change was made.');
  console.log('This does not verify browser rendering, teaching accuracy, live speech timing, or account billing.');
}

main().catch((error: unknown) => {
  if (error instanceof TutorError && (error.diagnostics || error.providerStatus !== undefined)) {
    console.error(JSON.stringify({ provider: 'Gemini', validated: false,
      providerStatus: Number.isInteger(error.providerStatus) && error.providerStatus! >= 400 && error.providerStatus! < 600 ? error.providerStatus : null,
      ...diagnosticMetadata(error.diagnostics) }));
  }
  console.error(error instanceof TutorError ? `${error.code}: ${error.message}` : 'The teaching probe failed. Check local configuration and account access.');
  process.exitCode = 1;
});
