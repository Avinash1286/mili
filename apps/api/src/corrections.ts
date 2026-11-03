import { randomUUID } from 'node:crypto';
import { StudyPackSchema, type LearningCard, type StudyPack, type ShareLink, type AssessmentEvaluation, type Artifact } from '@tokai/contracts';
import type { Principal } from '@tokai/db';
import { deriveMastery, reviseCard } from '@tokai/learning';
import { optionalResource, reflectMastery, type AttemptRecord, type ProductContext } from './product-context.js';

/** Called in the same owner transaction as a correction; immutable attempts remain intact. */
export async function invalidateConcepts(context: ProductContext, p: Principal, sessionId: string, concepts: string[], reason: string, retainedCardId?: string) {
  const { store, now } = context, session = await store.get(p, sessionId), time = now();
  const attempts = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId, limit: 200 });
  for (const record of attempts) {
    if (!record.data.evidence.some(item => concepts.includes(item.conceptId) && !item.invalidatedAt)) continue;
    const previous = record.data.evaluation;
    await store.resources.put(p, 'evaluation-history', previous.id, previous, { expectedRevision: -1, sessionId });
    const evaluation: AssessmentEvaluation = { ...previous, id: randomUUID(), revision: previous.revision + 1, supersedesEvaluationId: previous.id, evaluatedAt: time, method: 'adjudicated', correctness: 'uncertain', reasoning: 'uncertain', confidence: 'low', criteria: [], misconceptionIds: [], feedback: 'A related learning reference was corrected. This earlier evaluation no longer supports mastery; revisit the corrected material and try a fresh question.' };
    record.data = { ...record.data, evaluation, evidence: record.data.evidence.map(item => !item.invalidatedAt && concepts.includes(item.conceptId) ? { ...item, invalidatedAt: time, invalidationReason: reason } : item) };
    await store.resources.put(p, 'attempt', record.id, record.data, { expectedRevision: record.revision, sessionId });
  }
  for (const record of await store.resources.list<LearningCard>(p, 'card', { sessionId, limit: 200 })) {
    if (record.id === retainedCardId || record.data.status !== 'active' || !record.data.conceptIds.some(id => concepts.includes(id))) continue;
    await store.resources.put(p, 'card', record.id, reviseCard(record.data, { status: 'needs-correction' }, time), { expectedRevision: record.revision, sessionId });
  }
  await reflectMastery(context, p, session, deriveMastery(attempts.flatMap(item => item.data.evidence), time));
  await invalidateStudyArtifacts(context, p, sessionId, 'A reference was corrected. Regenerate this study pack before relying on its earlier explanations.');
  await store.appendEvent(p, sessionId, { id: randomUUID(), type: 'learning.corrected', data: { conceptIds: concepts, reason } });
}

/** Reconcile visible evidence and revoke immutable derivatives in the caller's transaction. */
export async function invalidateStudyArtifacts(context: ProductContext, p: Principal, sessionId: string, reason: string) {
  const { store, now } = context, time = now(), session = await store.get(p, sessionId);
  const pack = await optionalResource<StudyPack>(store, p, 'study-pack', sessionId);
  if (pack) {
    const attempts = await store.resources.list<AttemptRecord>(p, 'attempt', { sessionId, limit: 200 });
    const cards = await store.resources.list<LearningCard>(p, 'card', { sessionId, limit: 200 });
    const updated = StudyPackSchema.parse({ ...pack.data, version: pack.data.version + 1, sessionRevision: session.revision,
      recommendations: [reason, ...pack.data.recommendations.filter(item => item !== reason)].slice(0, 20),
      attempts: attempts.map(item => ({ attempt: item.data.attempt, evaluation: item.data.evaluation })),
      cards: cards.map(item => item.data), mastery: deriveMastery(attempts.flatMap(item => item.data.evidence), time),
      recap: { text: '', status: 'not-requested', completedBeatIds: [] } });
    await store.resources.put(p, 'study-pack', sessionId, updated, { expectedRevision: pack.revision, sessionId });
  }
  for (const link of await store.resources.list<ShareLink & { pack: StudyPack }>(p, 'share', { sessionId, limit: 100 })) if (!link.data.revoked) await store.resources.put(p, 'share', link.id, { ...link.data, revoked: true }, { expectedRevision: link.revision, sessionId });
  for (const artifact of await store.resources.list<Artifact>(p, 'artifact', { sessionId, limit: 100 })) if (artifact.data.status === 'ready') await store.resources.put(p, 'artifact', artifact.id, { ...artifact.data, status: 'failed', revision: artifact.data.revision + 1, updatedAt: time, error: 'Related feedback or learning content changed. Regenerate this artifact before downloading or playing it.' }, { expectedRevision: artifact.revision, sessionId });
}
