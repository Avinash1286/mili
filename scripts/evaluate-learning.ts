import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EVALUATION_CASES, EVALUATION_VERSION, type AssessmentCase, type BoundaryCase, type Split } from '../content/evaluations/learning-v1';
import { SOURCE_AUDIT, SOURCE_AUDIT_DATE } from '../content/evaluations/source-audit';
import { AssessmentAnswerSchema, AssessmentEvaluationSchema, BoardSchema, DiagramSpecSchema, VoiceClientEventSchema, applyBoardTransaction, layoutDiagram, resolveSelection, type Session } from '../packages/contracts/src/index';
import { applyAssistance, createPresentation, deriveMastery, evaluateAttempt, getLessonPack, listLessonPacks, projectAssessment, validateLessonPack } from '../packages/learning/src/index';
import { createLesson } from '../packages/tutor-core/src/lessons';
import { sampleTeachingReply } from '../packages/tutor-core/src/sample-teaching';
import { plainTeachingBeat, validateTeachingPlan } from '../packages/tutor-core/src/teaching';

const NOW = '2026-11-03T12:00:00.000Z';
const root = resolve(dirname(process.argv[1]!), '..');
const options = new Set(process.argv.slice(2));
for (const option of options) assert(['--split=development', '--split=holdout', '--split=all', '--report'].includes(option), `Unknown option ${option}. This runner is offline and has no --live option.`);
assert([...options].filter(value => value.startsWith('--split=')).length <= 1, 'Choose one evaluation split.');
const split = ([...options].find(value => value.startsWith('--split='))?.split('=')[1] ?? 'all') as Split | 'all';
let networkAttempts = 0;
// Fail closed if a future refactor accidentally calls an HTTP provider from here.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network access is disabled in the offline evaluation runner.'); };

function errorCode(operation: () => unknown, expected: string) {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  assert(caught && typeof caught === 'object' && 'code' in caught, `Expected a coded ${expected} rejection.`);
  assert.equal(caught.code, expected);
}
function lesson(value: BoundaryCase): Session { return createLesson({ id: `evaluation-${value.id}`, topic: value.topic, mode: 'sample', now: NOW, messageId: 'intro' }); }
async function assess(value: AssessmentCase) {
  const pack = getLessonPack(value.topic)!;
  const definition = pack.assessments.find(item => item.id === value.assessmentId);
  assert(definition, `Missing assessment ${value.assessmentId}.`);
  const answer = AssessmentAnswerSchema.parse(value.answer);
  let presentation = createPresentation(definition, `presentation-${value.id}`, NOW);
  if (value.assisted) presentation = applyAssistance(definition, presentation, { id: `hint-${value.id}`, kind: 'hint', hintId: definition.hints[0]!.id, at: NOW });
  const result = await evaluateAttempt(definition, presentation, { attemptId: `attempt-${value.id}`, presentationId: presentation.id, assessmentId: definition.id, assessmentVersion: definition.version, answer }, { sessionId: 'evaluation-session', evaluationId: `grade-${value.id}`, now: NOW });
  AssessmentEvaluationSchema.parse(result.evaluation);
  assert.equal(result.evaluation.correctness, value.expected);
  const outcome = value.expected === 'correct' ? value.assisted ? 'assisted-correct' : 'independent-correct' : value.expected;
  assert(result.evidence.length > 0 && result.evidence.every(item => item.outcome === outcome), 'Evidence must retain the observed correctness and assistance.');
  assert.equal(result.attempt.assisted, !!value.assisted);
  assert(result.evaluation.sourceRefs.length > 0, 'Authored feedback must retain its sources.');
  assert(deriveMastery(result.evidence, NOW).every(item => item.state !== 'demonstrated'), 'One answer alone cannot establish demonstrated mastery.');
  const projected = projectAssessment(definition);
  for (const key of ['grading', 'hints', 'explanation', 'sourceRefs']) assert(!Object.hasOwn(projected, key), `Public assessment leaked ${key}.`);
  return { observed: result.evaluation.correctness, method: result.evaluation.method, kind: definition.kind, evidence: outcome };
}
async function boundary(value: BoundaryCase) {
  const session = lesson(value), before = JSON.stringify(session);
  switch (value.scenario) {
    case 'sample-diagram': {
      const reply = sampleTeachingReply(session, value.learnerTurn);
      assert(reply.beats?.length && reply.beats.some(beat => beat.boardCommands.length > 0), 'Requested prepared diagram must have real commands.');
      const beats = validateTeachingPlan(session, reply.beats);
      let board = session.board;
      for (const [index, beat] of beats.entries()) if (beat.boardCommands.length) board = applyBoardTransaction(board, { operationId: `${value.id}-${index}`, expectedRevision: board.revision ?? 0, commands: beat.boardCommands }, 'tutor');
      BoardSchema.parse(board);
      assert(board.nodes.length > session.board.nodes.length && board.frames?.length, 'Diagram must add visible semantic objects and a frame.');
      if (value.topic === 'fractions') assert(board.nodes.filter(node => node.fraction).length >= 2, 'Fraction semantics must survive layout.');
      assert.equal(JSON.stringify(session), before, 'Preview validation must not mutate persisted input.');
      return { observed: 'valid-diagram', commands: beats.reduce((count, beat) => count + beat.boardCommands.length, 0) };
    }
    case 'selection-resolved': {
      const result = resolveSelection(session.board, { shapeIds: ['co2'], conceptIds: ['invented-client-concept'], boardRevision: 0 });
      assert.equal(result.status, 'resolved'); assert.deepEqual(result.conceptIds, ['co2']);
      return { observed: result.status };
    }
    case 'selection-stale': {
      const result = resolveSelection({ ...session.board, revision: 2 }, { shapeIds: [session.board.nodes[0]!.id], conceptIds: [], boardRevision: 1 });
      assert.equal(result.status, 'stale'); assert.equal(result.nodes.length, 0);
      return { observed: result.status };
    }
    case 'selection-ambiguous': {
      const result = resolveSelection(session.board, { shapeIds: session.board.nodes.slice(0, 2).map(node => node.id), conceptIds: [], boardRevision: 0 });
      assert.equal(result.status, 'ambiguous'); assert.equal(result.conceptIds.length, 0); assert(result.clarification);
      return { observed: result.status };
    }
    case 'selection-missing': {
      const result = resolveSelection(session.board, { shapeIds: ['deleted-card'], conceptIds: [], boardRevision: 0 });
      assert.equal(result.status, 'stale'); assert.equal(result.nodes.length, 0);
      return { observed: result.status };
    }
    case 'source-gap': {
      const beat = plainTeachingBeat('The uploaded book supports this.'); beat.sourceRefs = ['fabricated-upload-source'];
      errorCode(() => validateTeachingPlan(session, [beat]), 'INVALID_SOURCE_REFERENCE');
      return { observed: 'rejected-invented-source' };
    }
    case 'student-overwrite': {
      session.board.nodes[0]!.author = 'student'; const snapshot = JSON.stringify(session.board);
      const beat = plainTeachingBeat('Replace the student answer.');
      beat.boardCommands = [{ type: 'upsert_node', node: { ...session.board.nodes[0]!, detail: 'Unauthorized replacement' } }];
      errorCode(() => validateTeachingPlan(session, [beat]), 'STUDENT_WORK_PROTECTED');
      assert.equal(JSON.stringify(session.board), snapshot);
      return { observed: 'protected-student-work' };
    }
    case 'map-reference': {
      const beat = plainTeachingBeat('Connect the idea.');
      beat.mapUpdate = { topicId: session.topic, expectedRevision: 0, mode: 'merge', nodes: [{ id: 'new-concept', label: 'Planet', status: 'introduced', boardNodeIds: ['does-not-exist'] }], edges: [] };
      errorCode(() => validateTeachingPlan(session, [beat]), 'INVALID_MAP_REFERENCE');
      return { observed: 'rejected-missing-map-reference' };
    }
    case 'invalid-graph': {
      const invalid = { id: 'graph', title: 'Current graph', template: 'graph', nodes: [{ id: 'curve', label: 'Run this', formula: 'process.exit()' }], edges: [] };
      assert.equal(DiagramSpecSchema.safeParse(invalid).success, false);
      // Parse is deliberately bypassed only to prove the actual public layout boundary rejects raw input too.
      errorCode(() => layoutDiagram(invalid as unknown as Parameters<typeof layoutDiagram>[0]), 'INVALID_DIAGRAM');
      return { observed: 'rejected-executable-graph' };
    }
    case 'silence': {
      assert.equal(VoiceClientEventSchema.safeParse({ type: 'input.text', requestId: value.id, text: ' \n\t ' }).success, false);
      return { observed: 'blank-transcript-rejected', scope: 'protocol-only' };
    }
    case 'interrupt': {
      assert(VoiceClientEventSchema.safeParse({ type: 'input.interrupt', outputEpoch: 0 }).success);
      return { observed: 'interrupt-command-accepted', scope: 'protocol-only; real cancellation covered by voice E2E' };
    }
    case 'off-topic': {
      const reply = sampleTeachingReply(session, value.learnerTurn);
      assert.match(reply.text, /fixed teaching guide/); assert.match(reply.text, /Live AI/);
      assert.equal(reply.beats?.flatMap(beat => beat.boardCommands).length ?? 0, 0);
      return { observed: 'sample-limitation-disclosed', scope: 'deterministic sample, not live prompt resistance' };
    }
    case 'injection-answer': {
      const result = await assess({ ...value, type: 'assessment', assessmentId: 'circuits-short-battery', answer: { kind: 'text', text: value.learnerTurn, mode: 'typed' }, expected: 'uncertain' });
      assert.equal(result.method, 'unavailable'); return result;
    }
  }
}

async function run() {
  assert(EVALUATION_CASES.length >= 40, 'The corpus must retain at least forty cases.');
  assert.equal(new Set(EVALUATION_CASES.map(item => item.id)).size, EVALUATION_CASES.length, 'Case IDs must be unique.');
  const audited = new Map(SOURCE_AUDIT.map(source => [source.id as string, source]));
  for (const pack of listLessonPacks()) {
    validateLessonPack(pack);
    for (const source of pack.sources) assert.equal(audited.get(source.sourceId)?.url, source.url, `Authored source ${source.sourceId} needs a matching URL audit record.`);
  }
  for (const item of EVALUATION_CASES) {
    assert(item.rationale && item.learnerTurn, `Case ${item.id} needs its independent rationale and learner turn.`);
    for (const id of item.sourceIds) assert.equal(audited.get(id)?.status, 'checked', `Case ${item.id} needs a checked source: ${id}.`);
  }
  for (const pack of listLessonPacks()) for (const requiredSplit of ['development', 'holdout']) assert(EVALUATION_CASES.some(item => item.topic === pack.topicId && item.split === requiredSplit), `${pack.topicId} needs both development and holdout coverage.`);
  const cases = EVALUATION_CASES.filter(item => split === 'all' || item.split === split);
  const results: { id: string; topic: string; split: Split; type: string; passed: boolean; detail?: unknown; failure?: string }[] = [];
  for (const item of cases) {
    try { results.push({ id: item.id, topic: item.topic, split: item.split, type: item.type, passed: true, detail: item.type === 'assessment' ? await assess(item) : await boundary(item) }); }
    catch (error) { results.push({ id: item.id, topic: item.topic, split: item.split, type: item.type, passed: false, failure: error instanceof Error ? error.message.slice(0, 800) : 'Unknown evaluation failure' }); }
  }
  assert.equal(networkAttempts, 0, 'Offline evaluation attempted network access.');
  const hash = createHash('sha256').update(await readFile(resolve(root, 'content/evaluations/learning-v1.ts'))).digest('hex');
  const packSha256 = createHash('sha256').update(JSON.stringify(listLessonPacks())).digest('hex');
  const runnerSha256 = createHash('sha256').update(await readFile(resolve(root, 'scripts/evaluate-learning.ts'))).digest('hex');
  const report = { version: EVALUATION_VERSION, corpusSha256: hash, packSha256, runnerSha256, evaluatedAt: new Date().toISOString(), fixtureClock: NOW, split, modelCalls: 0, networkAttempts, sampleSize: results.length, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, byTopic: Object.fromEntries(listLessonPacks().map(pack => [pack.topicId, { total: results.filter(item => item.topic === pack.topicId).length, passed: results.filter(item => item.topic === pack.topicId && item.passed).length }])), bySplit: Object.fromEntries(['development', 'holdout'].map(group => [group, { total: results.filter(item => item.split === group).length, passed: results.filter(item => item.split === group && item.passed).length }])), sourceAudit: { date: SOURCE_AUDIT_DATE, checked: SOURCE_AUDIT.filter(item => item.status === 'checked').length, unavailable: SOURCE_AUDIT.filter(item => item.status !== 'checked').map(item => item.id) }, limitations: ['Expected invariant compliance, not live model answer accuracy.', 'No human curriculum review or measured learning outcome.', 'No speech intelligibility, accent/noise, hardware or subjective pedagogy evaluation.', 'Holdout labels are fixed before this run, but cases and answers are public and share an author with the implementation.'], results };
  if (options.has('--report')) {
    const target = resolve(root, `var/probes/learning-evaluation-${split}.json`); await mkdir(dirname(target), { recursive: true }); await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  const { results: _results, ...summary } = report;
  console.log(JSON.stringify({ ...summary, failures: results.filter(item => !item.passed) }, null, 2));
  if (report.failed) process.exitCode = 1;
}
void run().catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed.'); process.exitCode = 1; }).finally(() => { globalThis.fetch = originalFetch; });
