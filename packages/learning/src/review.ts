import { LearningCardSchema, LearningCardTemplateSchema, ReviewRatingSchema, ReviewReceiptSchema, ReviewScheduleSchema, ReviewSubmissionSchema, type LearningCard, type LearningSourceRef, type LessonPack, type ReviewRating, type ReviewReceipt, type ReviewSchedule, type ReviewSubmission } from '@tokai/contracts';
import { DAY, check, immutable, normalizeText, timestamp, unique } from './common';

export function createCardSchedule(now: string): ReviewSchedule {
  timestamp(now); return immutable(ReviewScheduleSchema.parse({ state: 'new', learningStep: 0, intervalDays: 0, dueAt: now, repetitions: 0, lapses: 0, revision: 0, algorithmVersion: 'tokai-review-v1' }));
}
/** A deterministic learning-step scheduler, not an implementation or accuracy claim of FSRS. */
export function scheduleReview(input: ReviewSchedule, rawRating: ReviewRating, now: string): ReviewSchedule {
  const schedule = ReviewScheduleSchema.parse(input), rating = ReviewRatingSchema.parse(rawRating), time = timestamp(now);
  check(!schedule.lastReviewedAt || time >= timestamp(schedule.lastReviewedAt), 'INVALID_TIME', 'A review cannot predate the previous review.');
  let state: ReviewSchedule['state'] = schedule.state, learningStep = schedule.learningStep, intervalDays = schedule.intervalDays, delay = 0, lapses = schedule.lapses;
  if (rating === 'again') { if (state === 'review') lapses++; state = 'learning'; learningStep = 0; delay = 60_000; }
  else if (state === 'review') {
    const factor = rating === 'hard' ? 1.2 : rating === 'good' ? 2 : 2.5;
    intervalDays = Math.min(365, Math.max(intervalDays + 1, Math.ceil(intervalDays * factor))); delay = intervalDays * DAY;
  } else if (rating === 'hard') { state = 'learning'; delay = 5 * 60_000; }
  else if (rating === 'easy') { state = 'review'; learningStep = 0; intervalDays = Math.max(4, intervalDays); delay = intervalDays * DAY; }
  else if (state === 'new' || learningStep === 0) { state = 'learning'; learningStep = 1; delay = 10 * 60_000; }
  else { state = 'review'; learningStep = 0; intervalDays = Math.max(1, Math.floor(intervalDays / 2)); delay = intervalDays * DAY; }
  return immutable(ReviewScheduleSchema.parse({ ...schedule, state, learningStep, intervalDays, dueAt: new Date(time + delay).toISOString(), lastReviewedAt: now, repetitions: schedule.repetitions + 1, lapses, revision: schedule.revision + 1 }));
}
function reviewFingerprint(submission: ReviewSubmission): string {
  return JSON.stringify([submission.reviewId, submission.cardId, submission.cardRevision, submission.expectedScheduleRevision, submission.rating, submission.suggestedRating ?? null, submission.attemptId ?? null]);
}
/** Persist receipt + resulting card schedule in one owner-scoped transaction. Check receipt before revisions on retries. */
export function createReviewReceipt(input: LearningCard, rawSubmission: ReviewSubmission, now: string, existingReceipt?: ReviewReceipt): ReviewReceipt {
  const submission = ReviewSubmissionSchema.parse(rawSubmission), fingerprint = reviewFingerprint(submission);
  if (existingReceipt) {
    const existing = ReviewReceiptSchema.parse(existingReceipt);
    check(existing.reviewId === submission.reviewId && existing.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'This review ID already represents a different review.');
    return immutable(existing);
  }
  const card = validateCard(input);
  check(card.id === submission.cardId && card.revision === submission.cardRevision && card.schedule.revision === submission.expectedScheduleRevision, 'VERSION_CONFLICT', 'The card or review schedule changed. Refresh before reviewing again.');
  check(card.status === 'active', 'CARD_INACTIVE', 'Only active cards can be reviewed.');
  check(timestamp(now) >= timestamp(card.createdAt), 'INVALID_TIME', 'A review cannot predate its card.');
  return immutable(ReviewReceiptSchema.parse({ ...submission, reviewedAt: now, overridden: submission.suggestedRating !== undefined && submission.rating !== submission.suggestedRating, schedule: scheduleReview(card.schedule, submission.rating, now), fingerprint }));
}
export function validateCard(input: unknown): LearningCard {
  const card = LearningCardSchema.parse(input);
  const { id, kind, front, back, hint, explanation, conceptIds, sourceRefs, diagram, targetIds, cloze, rubricAssessmentId } = card;
  LearningCardTemplateSchema.parse({ id, kind, front, back, hint, explanation, conceptIds, sourceRefs, diagram, targetIds, cloze, rubricAssessmentId });
  check(timestamp(card.updatedAt) >= timestamp(card.createdAt), 'INVALID_TIME', 'A card update cannot predate creation.');
  return card;
}
export function instantiatePackCards(pack: LessonPack, options: { sessionId: string; coveredConceptIds: string[]; createId: () => string; now: string; includeReference?: boolean }): LearningCard[] {
  timestamp(options.now);
  const covered = new Set(options.coveredConceptIds), cards: LearningCard[] = [];
  for (const template of pack.cardTemplates) {
    const wasCovered = template.conceptIds.some(id => covered.has(id));
    if (!wasCovered && !options.includeReference) continue;
    const { id: templateId, ...fields } = template;
    cards.push(validateCard({ ...fields, id: options.createId(), templateId, packId: pack.id, revision: 1, originSessionId: options.sessionId, originKind: wasCovered ? 'covered-concept' : 'lesson-reference', status: 'active', createdAt: options.now, updatedAt: options.now, schedule: createCardSchedule(options.now) }));
  }
  check(unique(cards.map(card => card.id)).length === cards.length, 'DUPLICATE_ID', 'Each instantiated card needs a new unique ID.');
  return immutable(cards);
}
export type CardRevision = Partial<Pick<LearningCard, 'front' | 'back' | 'hint' | 'explanation' | 'sourceRefs' | 'cloze'>> & { status?: 'active' | 'discarded' | 'needs-correction' };
export function reviseCard(input: LearningCard, changes: CardRevision, now: string): LearningCard {
  const card = validateCard(input); timestamp(now);
  check(Object.keys(changes).length > 0 && Object.keys(changes).every(key => ['front', 'back', 'hint', 'explanation', 'sourceRefs', 'status', 'cloze'].includes(key)), 'INVALID_CARD_EDIT', 'Only card content, citations and correction status can be edited.');
  check(card.status !== 'merged', 'CARD_INACTIVE', 'Edit the retained card after a merge.');
  check(card.kind !== 'cloze' || changes.cloze || (changes.front === undefined && changes.back === undefined), 'INVALID_CARD_EDIT', 'Edit the omission fields for a cloze card so its prompt and answer stay consistent.');
  check(timestamp(now) >= timestamp(card.updatedAt), 'INVALID_TIME', 'An edit cannot predate the previous edit.');
  const contentChanged = Object.entries(changes).some(([key, value]) => key !== 'status' && JSON.stringify(value) !== JSON.stringify(card[key as keyof LearningCard]));
  const next = { ...card, ...changes, revision: card.revision + 1, updatedAt: now, originKind: contentChanged ? 'student-edit' as const : card.originKind };
  if (contentChanged || changes.status === 'needs-correction') next.schedule = { ...createCardSchedule(now), revision: card.schedule.revision + 1 };
  if (next.kind === 'cloze' && changes.cloze) { next.front = `${changes.cloze.before} […] ${changes.cloze.after}`; next.back = `${changes.cloze.before}${changes.cloze.answer}${changes.cloze.after}`; }
  return immutable(validateCard(next));
}
export function mergeSourceRefs(refs: LearningSourceRef[], limit = 12): LearningSourceRef[] {
  const result = new Map<string, LearningSourceRef>();
  for (const ref of refs) { const key = JSON.stringify([ref.sourceId, ref.sourceVersion, ref.section ?? null, ref.page ?? null, ref.chunkId ?? null]); const existing = result.get(key); check(!existing || existing.url === ref.url, 'SOURCE_CONFLICT', 'The same source reference cannot point to different URLs.'); result.set(key, ref); }
  check(result.size <= limit, 'SOURCE_LIMIT', `This artifact can reference at most ${limit} distinct source locations.`);
  return [...result.values()];
}
export function mergeDuplicateCards(input: LearningCard[], targetId: string, now: string): LearningCard[] {
  timestamp(now); const cards = input.map(validateCard), target = cards.find(card => card.id === targetId);
  check(target && target.status === 'active', 'CARD_INACTIVE', 'Choose an active card to retain.');
  check(unique(cards.map(card => card.id)).length === cards.length, 'DUPLICATE_ID', 'A card must appear only once in the merge request.');
  const signature = (card: LearningCard) => JSON.stringify([card.kind, normalizeText(card.front), normalizeText(card.back), [...card.conceptIds].sort(), card.cloze ?? null, card.targetIds ?? null, card.diagram ?? null, card.rubricAssessmentId ?? null]);
  check(cards.length >= 2 && cards.every(card => card.status === 'active' && card.packId === target.packId && signature(card) === signature(target)), 'NOT_DUPLICATES', 'Merge requires matching prompts, answers, concepts and specialized card content.');
  check(cards.every(card => timestamp(now) >= timestamp(card.updatedAt)), 'INVALID_TIME', 'A merge cannot predate a card update.');
  const sourceRefs = mergeSourceRefs(cards.flatMap(card => card.sourceRefs));
  return immutable(cards.map(card => validateCard(card.id === targetId ? { ...card, sourceRefs, revision: card.revision + 1, updatedAt: now } : { ...card, status: 'merged', mergedIntoId: targetId, revision: card.revision + 1, updatedAt: now })));
}
export function dueCards(cards: LearningCard[], now: string): LearningCard[] { const time = timestamp(now); return immutable(cards.map(validateCard).filter(card => card.status === 'active' && timestamp(card.schedule.dueAt) <= time).sort((left, right) => timestamp(left.schedule.dueAt) - timestamp(right.schedule.dueAt) || left.id.localeCompare(right.id))); }
