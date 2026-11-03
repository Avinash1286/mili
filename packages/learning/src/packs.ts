import { LessonPackSchema, type LessonPack, type LearningSourceRef } from '@tokai/contracts';
import { AUTHORED_LESSON_PACKS } from '../../../content/lessons';
import { asNumber, check, immutable, parseNumeric, unique } from './common';

export function validateLessonPack(input: unknown): LessonPack {
  const pack = LessonPackSchema.parse(input);
  for (const collection of [pack.objectives, pack.concepts, pack.misconceptions, pack.workedExamples, pack.diagrams, pack.assessments, pack.cardTemplates, pack.sources.map(source => ({ id: source.sourceId }))]) check(unique(collection.map(item => item.id)).length === collection.length, 'INVALID_PACK', 'Authored IDs must be unique within their collection.');
  const conceptIds = new Set(pack.concepts.map(item => item.id)), objectiveIds = new Set(pack.objectives.map(item => item.id));
  const validateRefs = (refs: LearningSourceRef[]) => {
    check(refs.length > 0, 'INVALID_PACK', 'Authored material must cite a verified reference.');
    for (const ref of refs) check(pack.sources.some(source => source.sourceId === ref.sourceId && source.sourceVersion === ref.sourceVersion && source.url === ref.url), 'INVALID_PACK', `Unknown or mismatched source: ${ref.sourceId}`);
  };
  const validateConcepts = (ids: string[]) => check(ids.length > 0 && ids.every(id => conceptIds.has(id)), 'INVALID_PACK', 'Authored material references unknown concepts.');
  for (const concept of pack.concepts) validateRefs(concept.sourceRefs);
  for (const item of [...pack.objectives, ...pack.misconceptions, ...pack.workedExamples, ...pack.diagrams, ...pack.assessments, ...pack.cardTemplates]) { validateConcepts(item.conceptIds); if ('sourceRefs' in item) validateRefs(item.sourceRefs); }
  for (const assessment of pack.assessments) {
    check(assessment.packId === pack.id && assessment.version === pack.version && assessment.objectiveIds.every(id => objectiveIds.has(id)), 'INVALID_PACK', 'Assessment references must match its authored pack.');
    if (assessment.grading.type === 'numeric') {
      const rule = assessment.grading;
      parseNumeric(rule.expected);
      check(unique(rule.acceptedUnits.map(unit => unit.unit)).length === rule.acceptedUnits.length, 'INVALID_PACK', 'Unit aliases must be unique.');
      for (const unit of rule.acceptedUnits) check(asNumber(parseNumeric(unit.factor)) > 0, 'INVALID_PACK', 'Unit conversion factors must be positive.');
      check(rule.acceptedUnits.some(unit => unit.unit === rule.canonicalUnit && asNumber(parseNumeric(unit.factor)) === 1), 'INVALID_PACK', 'The canonical unit must convert to itself.');
    }
    if (assessment.grading.type === 'rubric') check(unique(assessment.grading.rubric.criteria.map(item => item.id)).length === assessment.grading.rubric.criteria.length, 'INVALID_PACK', 'Rubric criterion IDs must be unique.');
  }
  for (const card of pack.cardTemplates) if (card.rubricAssessmentId) check(pack.assessments.some(item => item.id === card.rubricAssessmentId && item.grading.type === 'rubric'), 'INVALID_PACK', 'Spoken cards need an authored rubric.');
  check(new Set(pack.assessments.map(item => item.kind)).size === 5 && new Set(pack.cardTemplates.map(item => item.kind)).size === 4, 'INVALID_PACK', 'Authored packs must cover every assessment and card type.');
  return immutable(pack);
}

const packs = AUTHORED_LESSON_PACKS.map(validateLessonPack);
export const listLessonPacks = (): LessonPack[] => immutable(packs);
export function getLessonPack(topicId: string, version?: string): LessonPack | undefined { const pack = packs.find(item => item.topicId === topicId && (!version || item.version === version)); return pack ? immutable(pack) : undefined; }
