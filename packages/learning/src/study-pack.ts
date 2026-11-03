import { StudyPackSchema, type AssessmentAttempt, type AssessmentEvaluation, type LearningCard, type LearningConcept, type LearningSourceRef, type LessonPack, type MasteryEvidence, type Session, type StudyPack } from '@tokai/contracts';
import { check, immutable, timestamp, unique } from './common';
import { deriveMastery } from './mastery';
import { mergeSourceRefs, validateCard } from './review';

export interface BuildStudyPackInput {
  session: Pick<Session, 'id' | 'title' | 'topic' | 'revision' | 'board'> & Partial<Pick<Session, 'teachingBeats' | 'lessonFocus' | 'plan' | 'settings' | 'notes'>>;
  pack?: LessonPack;
  attempts: { attempt: AssessmentAttempt; evaluation: AssessmentEvaluation }[];
  evidence: MasteryEvidence[];
  cards: LearningCard[];
  notes?: string;
  unresolvedQuestions?: string[];
  sourceRefs?: LearningSourceRef[];
  goal?: string;
  now: string;
  id: string;
  version?: number;
}

/** Caller supplies owner-scoped records. No content generator and no mastery inference from lesson prose. */
export function buildStudyPack(input: BuildStudyPackInput): StudyPack {
  timestamp(input.now);
  const { session, pack } = input;
  check(!pack || pack.topicId === session.topic, 'PACK_MISMATCH', 'The reference lesson must match this session topic.');
  const beats = session.teachingBeats ?? [];
  const completedNarration = beats.filter(beat => beat.status === 'completed' && (beat.playedMs ?? 0) > 0).map(beat => ({ beatId: beat.beatId, text: beat.spokenText, conceptIds: beat.conceptIds, playedMs: beat.playedMs! }));
  const partialNarration = beats.filter(beat => beat.status !== 'completed' && (beat.playedMs ?? 0) > 0).map(beat => ({ beatId: beat.beatId, conceptIds: beat.conceptIds, playedMs: beat.playedMs! }));
  check(unique(beats.map(beat => beat.beatId)).length === beats.length, 'DUPLICATE_ID', 'Teaching beats must have unique IDs.');
  const attempts = input.attempts.filter(item => item.attempt.sessionId === session.id);
  for (const item of attempts) check(item.attempt.attemptId === item.evaluation.attemptId && item.attempt.assessmentId === item.evaluation.assessmentId && item.attempt.assessmentVersion === item.evaluation.assessmentVersion, 'EVALUATION_MISMATCH', 'Each evaluation must belong to its immutable attempt.');
  const cards = input.cards.filter(card => card.originSessionId === session.id).map(validateCard);
  const sourceRefs = mergeSourceRefs([...(pack?.sources ?? []), ...(input.sourceRefs ?? []), ...attempts.flatMap(item => item.evaluation.sourceRefs), ...cards.flatMap(card => card.sourceRefs)], 120);
  const goal = input.goal || session.settings?.goal || session.lessonFocus?.goal || `Explore ${session.title}`;
  const referenceConcepts: LearningConcept[] = pack ? pack.concepts : session.board.nodes.filter(node => node.shape !== 'annotation').map(node => ({ id: node.id, label: node.label.slice(0, 100) || 'Board idea', explanation: node.detail || node.description || `Board reference: ${node.label}`, sourceRefs: sourceRefs.filter(ref => node.sourceRefs?.includes(ref.sourceId) || node.sourceRefs?.includes(ref.chunkId ?? '')).slice(0, 12) }));
  const objectives = pack?.objectives ?? (session.plan?.objectives.length ? session.plan.objectives : [goal]).map((text, index) => ({ id: `objective-${index + 1}`, text, conceptIds: referenceConcepts.slice(0, 24).map(concept => concept.id) }));
  const packId = pack?.id ?? `session:${session.id}`;
  const attemptIds = new Set(attempts.map(item => item.attempt.attemptId));
  // Only assessment evidence tied to records in this study pack participates in its estimate.
  const evidence = input.evidence.filter(item => attemptIds.has(item.attemptId));
  const mastery = deriveMastery(evidence, input.now, referenceConcepts.map(concept => ({ packId, conceptId: concept.id })));
  const recommendations: string[] = [];
  if (attempts.some(item => item.evaluation.correctness === 'uncertain')) recommendations.push('Revisit answers marked uncertain. Compare the reference explanation or request a fresh evaluation; uncertain grading did not count as demonstrated understanding.');
  if (attempts.some(item => item.evaluation.correctness === 'incorrect' || item.evaluation.correctness === 'partial')) recommendations.push('Review corrections, then try a different question on the same concept.');
  if (attempts.some(item => item.attempt.assisted)) recommendations.push('Try an independent retrieval attempt after a break. Hinted or revealed answers remain recorded as assisted.');
  if (cards.some(card => card.status === 'active')) recommendations.push('Review active cards when due and choose the recall rating that reflects your own experience.');
  if (!attempts.length) recommendations.push('Complete a practice question to add evidence of understanding; reading or listening alone does not establish mastery.');
  if (partialNarration.length) recommendations.push('Return to the interrupted explanation if useful. Only fully played narration is included in the completed audio section.');
  const recapIntro = completedNarration.length ? 'Here is a recap of narration that finished playing in this session.' : 'No complete spoken explanation was recorded as played. The study pack still contains reference material, your board and any practice results.';
  const recapText = [recapIntro, ...completedNarration.map(beat => beat.text)].join(' ').slice(0, 4000);
  return immutable(StudyPackSchema.parse({ id: input.id, version: input.version ?? 1, sessionId: session.id, title: session.title.slice(0, 200), topicId: session.topic, generatedAt: input.now, sessionRevision: session.revision, boardRevision: session.board.revision ?? 0,
    ...(pack ? { packId: pack.id, packVersion: pack.version } : {}), objectives, referenceConcepts, completedNarration, partialNarration, attempts, mastery,
    unresolvedQuestions: input.unresolvedQuestions ?? [], notes: input.notes ?? session.notes ?? '', cards, recommendations,
    nextLessonSuggestion: pack?.nextLessonSuggestion ?? `Continue toward your goal: ${goal}`.slice(0, 4000), board: session.board, sourceRefs,
    recap: { text: recapText, status: 'not-requested', completedBeatIds: completedNarration.map(beat => beat.beatId) },
  }));
}

const markdown = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
const bullets = (items: string[]): string => items.length ? items.map(item => `- ${markdown(item)}`).join('\n') : '_None recorded._';
export function exportStudyPackMarkdown(raw: StudyPack): string {
  const pack = StudyPackSchema.parse(raw), lines = [`# ${markdown(pack.title)}`, '', `Study pack version ${pack.version} · ${pack.generatedAt}`, '', '## Objectives', '', bullets(pack.objectives.map(item => item.text)), '', '## Completed spoken explanations', '',
    pack.completedNarration.length ? pack.completedNarration.map(item => `- ${markdown(item.text)} (${Math.round(item.playedMs)} ms played; beat ${markdown(item.beatId)})`).join('\n') : '_No full narration was recorded as played._', '', '## Interrupted narration', '',
    pack.partialNarration.length ? pack.partialNarration.map(item => `- Beat ${markdown(item.beatId)}: ${Math.round(item.playedMs)} ms heard. Full text is omitted because it was not completed.`).join('\n') : '_None recorded._', '', '## Reference material', '',
    'These are reference explanations, not a claim that every item was taught or heard.', '', ...pack.referenceConcepts.flatMap(item => [`### ${markdown(item.label)}`, '', markdown(item.explanation), '']), '## Practice record', '',
    ...pack.attempts.flatMap(({ attempt, evaluation }) => [`### ${markdown(attempt.assessmentId)}`, '', `Result: ${evaluation.correctness}; reasoning: ${evaluation.reasoning}; grader confidence: ${evaluation.confidence}; ${attempt.assisted ? 'assisted' : 'independent'} attempt.`, '', `Answer: ${markdown(formatAnswer(attempt))}`, '', markdown(evaluation.feedback), '', `Reference explanation: ${markdown(evaluation.explanation)}`, '']),
    '## Understanding evidence', '', bullets(pack.mastery.map(item => `${item.conceptId}: ${item.state} (${item.confidence}). ${item.explanation}`)), '', '## Questions to revisit', '', bullets(pack.unresolvedQuestions), '', '## Your notes', '', markdown(pack.notes) || '_No notes._', '', '## Cards', '',
    ...pack.cards.filter(card => card.status === 'active').flatMap(card => [`### ${markdown(card.front)}`, '', markdown(card.back), '', `Origin: ${card.originKind}; next review: ${card.schedule.dueAt}`, '']), '## Next steps', '', bullets(pack.recommendations), '', markdown(pack.nextLessonSuggestion), '', '## Sources', '',
    pack.sourceRefs.length ? pack.sourceRefs.map(ref => `- ${markdown(ref.title)}${ref.section ? `, ${markdown(ref.section)}` : ''}${ref.page ? `, page ${ref.page}` : ''} (${markdown(ref.sourceId)}, version ${markdown(ref.sourceVersion)})${ref.url ? ` — [Open source](${ref.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : ''}`).join('\n') : '_No citations were supplied. Generated reference text is not presented as source-verified._', '', '## Board snapshot', '', `${pack.board.nodes.length} objects and ${pack.board.edges.length} connections at board revision ${pack.boardRevision}. Use the separate board export for its visual layout.`, ''];
  return lines.join('\n');
}
function formatAnswer(attempt: AssessmentAttempt): string {
  const answer = attempt.answer;
  if (answer.kind === 'text') return answer.text;
  if (answer.kind === 'numeric') return `${answer.value} ${answer.unit}`.trim();
  if (answer.kind === 'choice') return answer.optionIds.join(', ');
  return Object.entries(answer.labels).map(([id, label]) => `${id}: ${label}`).join('; ');
}
function csvCell(raw: string): string {
  // Prevent spreadsheet formula execution while preserving the unmodified content in the JSON export.
  const safe = /^[\s]*[=+\-@]|^[\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function exportCardsCsv(input: LearningCard[]): string {
  const cards = input.map(validateCard), rows = [['id', 'kind', 'front', 'back', 'hint', 'conceptIds', 'origin', 'status', 'dueAt', 'sourceRefs'], ...cards.map(card => [card.id, card.kind, card.front, card.back, card.hint, card.conceptIds.join(';'), card.originKind, card.status, card.schedule.dueAt, card.sourceRefs.map(ref => `${ref.sourceId}@${ref.sourceVersion}`).join(';')])];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function exportCardsJson(input: LearningCard[]): string { return JSON.stringify({ format: 'tokai-cards-v1', cards: input.map(validateCard) }, null, 2); }
export function exportStudyPackJson(input: StudyPack): string { return JSON.stringify({ format: 'tokai-study-pack-v1', studyPack: StudyPackSchema.parse(input) }, null, 2); }
