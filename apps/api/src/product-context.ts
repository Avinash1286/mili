import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { LearnerPreferencesSchema, type LearnerPreferences, type Session, type AssessmentDefinition, type AssessmentAttempt, type AssessmentEvaluation, type MasteryEvidence, type LearningCard, type StudyPack, type Artifact, type MasteryEstimate } from '@tokai/contracts';
import { StoreError, type Store, type Principal, type ObjectStore, type Resource } from '@tokai/db';
import { getLessonPack, instantiatePackCards, deriveMastery, projectAssessment } from '@tokai/learning';
import type { synthesizeSpeech, createSynthesizer, createTranscriber } from '@tokai/speech';
import type { generateLessonPlan, generateAssessment, generateLearningCards, createGeminiRubricGrader } from '@tokai/tutor-core/learning';

export type AttemptRecord = { attempt: AssessmentAttempt; evaluation: AssessmentEvaluation; evidence: MasteryEvidence[]; fingerprint: string };
export type ProductProviders = { speech?: typeof synthesizeSpeech; recap?: typeof createSynthesizer; transcriber?: typeof createTranscriber; plan?: typeof generateLessonPlan; assessment?: typeof generateAssessment; cards?: typeof generateLearningCards; rubric?: ReturnType<typeof createGeminiRubricGrader> };
export type ProductContext = { store: Store; objects: ObjectStore; env: Record<string, string | undefined>; now: () => string; closeSession: (id: string) => Promise<void>; providers?: ProductProviders };
export const parse = <T>(schema: z.ZodType<T>, input: unknown): T => { const result = schema.safeParse(input); if (!result.success) throw new StoreError(400, 'INVALID_REQUEST', 'The request contains invalid or missing fields.'); return result.data; };
export const principal = (request: FastifyRequest, store: Store) => store.authenticate(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined);
export const optionalResource = async <T>(store: Store, p: Principal, kind: string, id: string): Promise<Resource<T> | undefined> => {
  try { return await store.resources.get<T>(p, kind, id); } catch (error) { if (error instanceof StoreError && error.status === 404) return undefined; throw error; }
};
export async function preferences(store: Store, p: Principal): Promise<{ preferences: LearnerPreferences; revision: number }> {
  const record = await optionalResource<LearnerPreferences>(store, p, 'preferences', p.ownerId);
  return { preferences: LearnerPreferencesSchema.parse(record?.data ?? {}), revision: record?.revision ?? -1 };
}
export const bumpSession = (session: Session, now: string): Session => ({ ...session, revision: session.revision + 1, updatedAt: now });
/** Source-only lessons must never inherit an unrelated prepared reference pack. */
export const authoredPack = (session: Pick<Session, 'topic' | 'settings'>) => session.settings?.grounding === 'sources-only' ? undefined : getLessonPack(session.topic);
export async function reflectMastery(context: ProductContext, p: Principal, session: Session, mastery: MasteryEstimate[]) {
  const status = (id: string) => { const item = mastery.find(item => item.conceptId === id); return item?.state === 'demonstrated' ? 'understood' as const : item?.state === 'needs-review' ? 'needs-help' as const : item && item.state !== 'unknown' ? 'practicing' as const : 'introduced' as const; };
  if (session.conceptMap) { session.conceptMap.nodes = session.conceptMap.nodes.map(node => ({ ...node, status: node.status === 'question' ? 'question' : status(node.id) })); session.conceptMap.revision++; }
  session.concepts = session.concepts.map(concept => ({ ...concept, status: status(concept.id) }));
  await context.store.save(p, bumpSession(session, context.now()));
}
export async function definitions(store: Store, p: Principal, session: Session): Promise<AssessmentDefinition[]> {
  const authored = authoredPack(session)?.assessments ?? [];
  const generated = await store.resources.list<AssessmentDefinition>(p, 'assessment', { sessionId: session.id, limit: 30 });
  return [...authored, ...generated.map(item => item.data)];
}
export async function definition(store: Store, p: Principal, session: Session, id: string) {
  const value = (await definitions(store, p, session)).find(item => item.id === id);
  if (!value) throw new StoreError(404, 'NOT_FOUND', 'Practice question not found.'); return value;
}
export async function initializeLearning(context: ProductContext, p: Principal, session: Session) {
  const { store, now } = context;
  if (await optionalResource(store, p, 'learning-init', session.id)) return;
  const pack = authoredPack(session);
  if (pack) for (const card of instantiatePackCards(pack, { sessionId: session.id, coveredConceptIds: [], createId: randomUUID, now: now(), includeReference: true })) {
    await store.resources.put(p, 'card', card.id, card, { expectedRevision: -1, sessionId: session.id });
  }
  await store.resources.put(p, 'learning-init', session.id, { version: 1 }, { expectedRevision: -1, sessionId: session.id });
}
export async function learningData(context: ProductContext, p: Principal, session: Session) {
  const { store, now } = context;
  const [defs, attempts, cards, studyPack, artifacts] = await Promise.all([
    definitions(store, p, session), store.resources.list<AttemptRecord>(p, 'attempt', { sessionId: session.id, limit: 200 }),
    store.resources.list<LearningCard>(p, 'card', { sessionId: session.id, limit: 200 }), optionalResource<StudyPack>(store, p, 'study-pack', session.id),
    store.resources.list<Artifact>(p, 'artifact', { sessionId: session.id, limit: 100 }),
  ]);
  const pack = authoredPack(session), evidence = attempts.flatMap(item => item.data.evidence);
  return { assessments: defs.map(projectAssessment), attempts: attempts.map(({ data }) => ({ attempt: data.attempt, evaluation: data.evaluation })),
    mastery: deriveMastery(evidence, now(), pack?.concepts.map(item => ({ packId: pack.id, conceptId: item.id }))),
    cards: cards.map(item => item.data), studyPack: studyPack?.data, artifacts: artifacts.map(item => item.data) };
}
export async function enqueueArtifact(context: ProductContext, p: Principal, session: Session, kind: Artifact['kind'], format?: Artifact['format']) {
  const { store, now } = context;
  // Deduplicate retries/repeated clicks while equivalent work is outstanding.
  const existing = (await store.resources.list<Artifact>(p, 'artifact', { sessionId: session.id, limit: 100 })).find(item => item.data.kind === kind && item.data.format === format && ['queued', 'running'].includes(item.data.status));
  if (existing) return existing.data;
  const artifact: Artifact = { id: randomUUID(), sessionId: session.id, kind, format, status: 'queued', revision: 0, createdAt: now(), updatedAt: now() };
  await store.resources.put(p, 'artifact', artifact.id, artifact, { expectedRevision: -1, sessionId: session.id });
  await store.outbox.enqueue(p, { id: randomUUID(), kind: 'artifact', sessionId: session.id, resourceKind: 'artifact', resourceId: artifact.id, expectedRevision: 0 });
  return artifact;
}
