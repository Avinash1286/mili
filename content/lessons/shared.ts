import type { AssessmentDefinition, ExplanationRubric, LearningCardTemplate, LearningConcept, LearningSourceRef, LessonPack, NumericRule } from '../../packages/contracts/src/learning';
import type { Board } from '../../packages/contracts/src/scene';

export const REVIEWED_AT = '2026-11-03T00:00:00.000Z';
export function source(sourceId: string, title: string, url: string, section: string): LearningSourceRef { return { sourceId, sourceVersion: 'reference-2026-11-03', title, url, section }; }
export function concept(id: string, label: string, explanation: string, sourceRefs: LearningSourceRef[]): LearningConcept { return { id, label, explanation, sourceRefs }; }
export function diagram(nodes: { id: string; label: string; detail?: string; explanation?: string }[], links: [string, string, string][]): Board {
  return { revision: 0, nodes: nodes.map((node, index) => ({ id: node.id, label: node.label, detail: node.detail ?? node.explanation ?? '', x: 40 + (index % 3) * 260, y: 40 + Math.floor(index / 3) * 190, kind: index === 0 ? 'root' : 'concept', author: 'tutor', conceptIds: [node.id], width: 220, height: 150 })), edges: links.map(([from, to, label], index) => ({ id: `edge-${index}`, from, to, label, author: 'tutor' })) };
}
type QuestionBase = { id: string; prompt: string; conceptIds: string[]; objectiveIds: string[]; hints: [string, string]; explanation: string; sourceRefs: LearningSourceRef[] };
function base(packId: string, input: QuestionBase) { return { ...input, id: `${packId}-${input.id}`, packId, version: '1.0.0', hints: input.hints.map((text, index) => ({ id: `hint-${index + 1}`, text })), responseInstructions: '' }; }
export function choice(packId: string, input: QuestionBase, options: [string, string][], correct: string): AssessmentDefinition { return { ...base(packId, input), kind: 'multiple-choice', options: options.map(([id, label]) => ({ id, label })), responseInstructions: 'Choose one answer.', grading: { type: 'choice', correctOptionIds: [correct] } }; }
export function numeric(packId: string, input: QuestionBase, rule: Omit<NumericRule, 'type'>): AssessmentDefinition { return { ...base(packId, input), kind: 'numeric', responseInstructions: rule.unitRequired ? `Enter a number and a unit compatible with ${rule.canonicalUnit}.` : 'Enter a decimal or a simple fraction, such as 3/4.', grading: { type: 'numeric', ...rule } }; }
export function explanation(packId: string, input: QuestionBase, kind: 'short-answer' | 'spoken-explanation', expected: [string, string][], acceptedAnswers: string[], contradictions: string[] = []): AssessmentDefinition {
  const rubric: ExplanationRubric = { version: '1.0.0', criteria: expected.map(([description, expected], index) => ({ id: `criterion-${index + 1}`, description, expected, required: true })), acceptedAnswers, contradictions };
  return { ...base(packId, input), kind, responseInstructions: kind === 'spoken-explanation' ? 'Explain in your own words. You can speak or type the same answer.' : 'Answer in your own words. Explain the connection, not only a keyword.', grading: { type: 'rubric', rubric } };
}
export function labeling(packId: string, input: QuestionBase, board: Board, targets: [string, string[]][]): AssessmentDefinition { return { ...base(packId, input), kind: 'diagram-label', diagram: board, responseInstructions: 'Give each lettered target its scientific label.', grading: { type: 'labels', targets: targets.map(([targetId, acceptedLabels]) => ({ targetId, acceptedLabels })) } }; }
export const dimensionless = (expected: string): Omit<NumericRule, 'type'> => ({ expected, canonicalUnit: '', acceptedUnits: [{ unit: '', factor: '1' }], absoluteTolerance: 0, relativeTolerance: 0, exact: true, unitRequired: false });
export const counted = (expected: string, singular: string, plural: string): Omit<NumericRule, 'type'> => ({ ...dimensionless(expected), canonicalUnit: singular, acceptedUnits: [{ unit: singular, factor: '1' }, { unit: plural, factor: '1' }], unitRequired: true });
export function cards(packId: string, input: {
  basic: [string, string, string, string, LearningSourceRef[]][];
  cloze: [string, string, string, string, string, LearningSourceRef[]][];
  labels: [string, string, Board, string, string, LearningSourceRef[]][];
  spoken: [string, string, string, string, string, LearningSourceRef[]][];
}): LearningCardTemplate[] {
  return [
    ...input.basic.map(([id, conceptId, front, back, sourceRefs]) => ({ id: `${packId}-${id}`, kind: 'basic' as const, front, back, hint: 'Recall the main role or relationship before revealing the answer.', explanation: back, conceptIds: [conceptId], sourceRefs })),
    ...input.cloze.map(([id, conceptId, before, answer, after, sourceRefs]) => ({ id: `${packId}-${id}`, kind: 'cloze' as const, front: `${before} […] ${after}`, back: `${before}${answer}${after}`, cloze: { before, answer, after }, hint: 'Read the whole sentence and identify the missing relationship.', explanation: `${before}${answer}${after}`, conceptIds: [conceptId], sourceRefs })),
    ...input.labels.map(([id, conceptId, board, targetId, back, sourceRefs]) => ({ id: `${packId}-${id}`, kind: 'diagram-label' as const, front: `Name target ${board.nodes.find(node => node.id === targetId)!.label} in the diagram.`, back, hint: 'Follow the arrows and use the labeled neighbors.', explanation: back, conceptIds: [conceptId], diagram: board, targetIds: [targetId], sourceRefs })),
    ...input.spoken.map(([id, conceptId, front, back, rubricAssessmentId, sourceRefs]) => ({ id: `${packId}-${id}`, kind: 'spoken-recall' as const, front, back, hint: 'Name the important parts, then explain how they are connected.', explanation: back, conceptIds: [conceptId], rubricAssessmentId: `${packId}-${rubricAssessmentId}`, sourceRefs })),
  ];
}
export function finishPack(pack: Omit<LessonPack, 'version' | 'authoredBy' | 'reviewedAt'>): LessonPack { return { ...pack, version: '1.0.0', authoredBy: 'Tokai original educational content', reviewedAt: REVIEWED_AT }; }
