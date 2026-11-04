import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FileObjectStore, FileStore, type Principal } from '@milli/db';
import { LearningCardSchema, SessionSettingsSchema, type AssessmentDefinition, type Artifact, type LearningCard, type Session, type Source, type StudyPack } from '@milli/contracts';
import { createCardSchedule, getLessonPack } from '@milli/learning';
import { createLesson, plainTeachingBeat, type GenerateReply } from '@milli/tutor-core';
import { createApp } from '../src/app';
import { runArtifact } from '../src/artifact-jobs';
import type { ProductContext, ProductProviders } from '../src/product-context';

vi.mock('@milli/grounding', async importOriginal => ({ ...await importOriginal<typeof import('@milli/grounding')>(), embedQuery: vi.fn(async () => { throw new Error('Embedding unavailable in isolated keyword-fallback test.'); }) }));
const NOW = '2026-11-03T12:00:00.000Z';
let directory: string, app: FastifyInstance, store: FileStore, objects: FileObjectStore, p: Principal, token: string, context: ProductContext;
const cardsProvider = vi.fn<NonNullable<ProductProviders['cards']>>();
const speechProvider = vi.fn<NonNullable<ProductProviders['speech']>>();
const tutor = vi.fn<GenerateReply>();
const headers = () => ({ authorization: `Bearer ${token}` });
beforeEach(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'tokai-grounding-learning-'));
  store = new FileStore(resolve(directory, 'db'), () => Date.parse(NOW)); objects = new FileObjectStore(resolve(directory, 'objects'));
  cardsProvider.mockReset(); tutor.mockReset(); speechProvider.mockReset();
  cardsProvider.mockResolvedValue([]);
  speechProvider.mockResolvedValue({ audio: Buffer.from('RIFF-test-fixture'), contentType: 'audio/wav' });
  tutor.mockImplementation(async input => {
    if (input.session.settings?.grounding === 'sources-only') expect(input.session.board.nodes).toEqual([]);
    const beat = plainTeachingBeat('The selected passage describes a leaf opening. What does the passage call it?');
    beat.boardCommands = [{ type: 'upsert_node', node: { id: 'source-concept', label: 'Leaf opening', detail: 'The selected passage describes stomata.', x: 0, y: 0, kind: 'concept', conceptIds: ['source-concept'], sourceRefs: input.session.citations?.map(citation => citation.chunkId) ?? [] } }];
    beat.conceptIds = ['source-concept']; beat.sourceRefs = input.session.citations?.map(citation => citation.chunkId) ?? [];
    return { text: beat.spokenText, beats: [beat] };
  });
  const env = { GEMINI_API_KEY: 'offline-injected-test', GEMINI_MODEL: 'offline-fixture', ASSEMBLYAI_API_KEY: 'offline-injected-test' };
  const providers: ProductProviders = { cards: cardsProvider, speech: speechProvider, plan: async input => ({ version: 1, goal: input.settings.goal, level: 'beginner', minutes: 15, objectives: ['Identify the leaf opening named in the selected passage.'], prerequisites: [], steps: [{ title: 'Read the passage', objective: 'Name its one described structure.' }], provenance: 'generated', status: 'ready' }) };
  app = await createApp({ dataDir: directory, store, objects, env, learning: providers, tutor, now: () => Date.parse(NOW), rateLimit: false });
  token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token; p = await store.authenticate(token);
  context = { store, objects, env, providers, now: () => NOW, closeSession: async () => {} };
});
afterEach(async () => {
  await app.close(); objects.close(); const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('tokai-grounding-learning-')) throw new Error('Unexpected cleanup path.');
  await rm(target, { recursive: true, force: true });
});
async function readySource() {
  const source: Source = { id: randomUUID(), title: 'One narrow leaf passage', filename: 'leaf.txt', mimeType: 'text/plain', bytes: 82, checksum: 'a'.repeat(64), revision: 0, status: 'ready', pages: 1, chunks: 1, createdAt: NOW, updatedAt: NOW };
  await store.resources.put(p, 'source', source.id, source, { expectedRevision: -1 });
  await store.chunks.replace(p, source.id, 0, [{ id: `${source.id}:0`, sourceId: source.id, revision: 0, ordinal: 0, text: 'Photosynthesis: stomata are small openings in the leaf surface.', page: 1, anchor: 'Leaf note' }]);
  return source;
}
async function artifact(sessionId: string, kind: 'study-pack' | 'cards') {
  const created = await app.inject({ method: 'POST', url: `/v1/sessions/${sessionId}/artifacts`, headers: headers(), payload: { kind } });
  expect(created.statusCode, created.body).toBe(200);
  const [job] = await store.outbox.claim('grounding-test-worker', 1, 120000);
  expect(job.resourceId).toBe(created.json().artifact.id);
  await runArtifact(context, p, job, new AbortController().signal);
  await store.outbox.complete(job.id, job.workerId!, job.fence);
  return (await store.resources.get<Artifact>(p, 'artifact', job.resourceId!)).data;
}

it('keeps a source-only seed-topic lesson free of authored board, practice, cards and study-pack leakage', async () => {
  const source = await readySource();
  const response = await app.inject({ method: 'POST', url: '/v1/lessons', headers: headers(), payload: { topic: 'photosynthesis', mode: 'live', sourceIds: [source.id], grounding: 'sources-only' } });
  expect(response.statusCode, response.body).toBe(201);
  const session: Session = response.json().session;
  const supplied = tutor.mock.calls[0]![0].session;
  // The real lesson route must start the provider from a blank, source-only scene.
  expect(supplied.board.nodes.map(node => node.id)).not.toContain('chloroplast');
  expect(session.board.nodes.map(node => node.id)).toEqual(['source-concept']);
  expect(session.flashcards).toEqual([]); expect(session.conceptMap?.nodes).toEqual([]);
  const learning = (await app.inject({ url: `/v1/sessions/${session.id}/learning`, headers: headers() })).json();
  expect(learning.assessments).toEqual([]); expect(learning.cards).toEqual([]);
  expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/assessments`, headers: headers(), payload: { assessmentId: 'photosynthesis-mc-carbon' } })).statusCode).toBe(404);
  await artifact(session.id, 'study-pack');
  const study = (await store.resources.get<StudyPack>(p, 'study-pack', session.id)).data;
  expect(study.packId).toBeUndefined(); expect(study.referenceConcepts.map(concept => concept.id)).toEqual(['source-concept']);
  expect(study.sourceRefs.map(ref => ref.sourceId)).toEqual([source.id]);
  expect(study.objectives.map(objective => objective.text)).toEqual(['Identify the leaf opening named in the selected passage.']);
  cardsProvider.mockImplementation(async input => [{ id: 'generated-source-card', kind: 'basic', front: 'Which leaf opening does this passage name?', back: 'Stomata.', hint: 'Read the leaf passage.', explanation: 'The selected passage names stomata.', conceptIds: ['source-concept'], sourceRefs: input.sourceRefs ?? [] }]);
  await artifact(session.id, 'cards');
  expect(cardsProvider.mock.calls[0]![0].rubricAssessments).toEqual([]);
  const cards = await store.resources.list<LearningCard>(p, 'card', { sessionId: session.id });
  expect(cards).toHaveLength(1); expect(cards[0]!.data.packId).toBe(`session:${session.id}`);
  expect(cards[0]!.data.sourceRefs.map(ref => ref.sourceId)).toEqual([source.id]);
});

async function customSpokenCard() {
  const session = createLesson({ id: randomUUID(), topic: 'Custom charge lesson', mode: 'live', now: NOW, messageId: 'intro' });
  session.settings = SessionSettingsSchema.parse({ goal: 'Explain charge and energy.', grounding: 'general', sourceIds: [], preferences: {} });
  session.board.nodes = [{ id: 'charge', label: 'Charge', detail: 'Charge is not consumed in a simple series circuit.', x: 0, y: 0, kind: 'concept', conceptIds: ['charge'] }];
  await store.create(p, session);
  const definition: AssessmentDefinition = { ...getLessonPack('circuits')!.assessments.find(item => item.kind === 'spoken-explanation')!, id: 'custom-spoken-rubric', packId: `session:${session.id}`, conceptIds: ['charge'], objectiveIds: ['charge-objective'] };
  await store.resources.put(p, 'assessment', definition.id, definition, { expectedRevision: -1, sessionId: session.id });
  const card = LearningCardSchema.parse({ id: randomUUID(), kind: 'spoken-recall', front: definition.prompt, back: definition.explanation, hint: 'Separate charge from energy.', explanation: definition.explanation, conceptIds: ['charge'], sourceRefs: [], rubricAssessmentId: definition.id, packId: `session:${session.id}`, revision: 1, originSessionId: session.id, originKind: 'lesson-reference', status: 'needs-correction', createdAt: NOW, updatedAt: NOW, schedule: createCardSchedule(NOW) });
  await store.resources.put(p, 'card', card.id, card, { expectedRevision: -1, sessionId: session.id });
  return { session, definition, card };
}
it('regenerates a live spoken-recall card with its canonical private rubric and preserves the rubric link', async () => {
  const { card, definition } = await customSpokenCard();
  cardsProvider.mockImplementation(async input => {
    expect(input.rubricAssessments).toEqual([definition]);
    input.onUsage?.({ provider: 'gemini', model: 'injected-metadata-fixture', requestId: 'card-fixture-1', inputTokens: 29, outputTokens: 11 });
    return [{ id: 'replacement', kind: 'spoken-recall', front: definition.prompt, back: definition.explanation, hint: 'Explain the roles in sequence.', explanation: definition.explanation, conceptIds: ['charge'], sourceRefs: [], rubricAssessmentId: definition.id }];
  });
  const response = await app.inject({ method: 'POST', url: `/v1/flashcards/${card.id}/regenerate`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); expect(cardsProvider).toHaveBeenCalledTimes(1);
  expect(response.json().card).toMatchObject({ id: card.id, kind: 'spoken-recall', rubricAssessmentId: definition.id, revision: 2, status: 'active' });
  const usage = (await app.inject({ url: '/v1/me/usage', headers: headers() })).json();
  expect(usage.kinds.find((kind: { kind: string }) => kind.kind === 'model')).toMatchObject({ used: 1, totals: { inputTokens: 29, outputTokens: 11 } });
});
it('rejects a generated spoken correction linked to a different rubric without replacing the card', async () => {
  const { card, definition } = await customSpokenCard();
  cardsProvider.mockResolvedValue([{ id: 'wrong-rubric-card', kind: 'spoken-recall', front: definition.prompt, back: definition.explanation, hint: 'Compare.', explanation: definition.explanation, conceptIds: ['charge'], sourceRefs: [], rubricAssessmentId: 'unrelated-rubric' }]);
  const response = await app.inject({ method: 'POST', url: `/v1/flashcards/${card.id}/regenerate`, headers: headers() });
  expect(response.statusCode).toBe(503); expect((await store.resources.get<LearningCard>(p, 'card', card.id)).data).toEqual(card);
});

it('uses the parent lesson language and voice for review speech and checks ownership before synthesis', async () => {
  const { session, card } = await customSpokenCard();
  const updated = { ...session, revision: session.revision + 1, settings: SessionSettingsSchema.parse({ ...session.settings, preferences: { ...session.settings!.preferences, language: 'spanish', voiceId: 'aai-jane' } }) };
  await store.save(p, updated, { expectedRevision: session.revision });
  const stranger = (await store.createGuest()).token;
  expect((await app.inject({ method: 'POST', url: `/v1/reviews/${card.id}/speech`, headers: { authorization: `Bearer ${stranger}` } })).statusCode).toBe(404);
  expect(speechProvider).not.toHaveBeenCalled();
  const response = await app.inject({ method: 'POST', url: `/v1/reviews/${card.id}/speech`, headers: headers() });
  expect(response.statusCode, response.body).toBe(200); expect(response.headers['content-type']).toContain('audio/wav');
  expect(speechProvider).toHaveBeenCalledTimes(1);
  expect(speechProvider.mock.calls[0]![0]).toMatchObject({ text: card.front, language: 'spanish', voiceId: 'aai-jane' });
  const usage = (await app.inject({ url: '/v1/me/usage', headers: headers() })).json();
  expect(usage.kinds.find((kind: { kind: string }) => kind.kind === 'speech')).toMatchObject({ used: [...card.front.trim()].length });
});

it('retains all eighty valid lesson citations in the study pack while bounding generated-card context to twelve', async () => {
  const source = await readySource(), record = await store.resources.get<Source>(p, 'source', source.id);
  await store.resources.put(p, 'source', source.id, { ...record.data, revision: 1, chunks: 80 }, { expectedRevision: record.revision });
  const chunks = Array.from({ length: 80 }, (_, index) => ({ id: `${source.id}:${index}`, sourceId: source.id, revision: 1, ordinal: index, text: `Leaf note ${index}: an independently anchored passage.`, page: index + 1, anchor: `Section ${index + 1}` }));
  await store.chunks.replace(p, source.id, 1, chunks);
  const session = createLesson({ id: randomUUID(), topic: 'An extended source lesson', mode: 'live', now: NOW, messageId: 'intro' });
  session.settings = SessionSettingsSchema.parse({ goal: 'Follow the selected leaf notes.', grounding: 'sources-only', sourceIds: [source.id], preferences: {} });
  session.citations = chunks.map(chunk => ({ id: `cite:${chunk.id}`, sourceId: source.id, sourceVersion: 1, chunkId: chunk.id, title: source.title, page: chunk.page, section: chunk.anchor, snippet: chunk.text }));
  session.board.nodes = [{ id: 'early-idea', label: 'An earlier idea', detail: 'An earlier source passage still matters.', x: 0, y: 0, kind: 'concept', conceptIds: ['early-idea'], sourceRefs: [chunks[0]!.id] }];
  await store.create(p, session);
  await artifact(session.id, 'study-pack');
  const study = (await store.resources.get<StudyPack>(p, 'study-pack', session.id)).data;
  expect(study.sourceRefs).toHaveLength(80); expect(study.sourceRefs[0]!.chunkId).toBe(chunks[0]!.id);
  expect(study.referenceConcepts[0]!.sourceRefs[0]!.chunkId).toBe(chunks[0]!.id);
  cardsProvider.mockImplementation(async input => [{ id: 'bounded-card', kind: 'basic', front: 'Recall a leaf note.', back: 'An anchored leaf passage.', hint: 'Read its source.', explanation: 'This card cites a recent selected passage.', conceptIds: ['early-idea'], sourceRefs: input.sourceRefs!.slice(-1) }]);
  await artifact(session.id, 'cards');
  expect(cardsProvider.mock.calls[0]![0].sourceRefs).toHaveLength(12);
  expect(cardsProvider.mock.calls[0]![0].sourceRefs![0]!.chunkId).toBe(chunks[68]!.id);
  expect((await store.resources.get<StudyPack>(p, 'study-pack', session.id)).data.sourceRefs).toHaveLength(80);
});

it('reconciles an appealed result in the saved pack and blocks earlier exports and share links', async () => {
  const created = await app.inject({ method: 'POST', url: '/v1/lessons', headers: headers(), payload: { topic: 'fractions', mode: 'sample' } });
  expect(created.statusCode, created.body).toBe(201); const session: Session = created.json().session;
  const definition = getLessonPack('fractions')!.assessments.find(item => item.id === 'fractions-num-quarters')!;
  const presented = (await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/assessments`, headers: headers(), payload: { assessmentId: definition.id } })).json();
  const answered = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/attempts`, headers: headers(), payload: { attemptId: randomUUID(), presentationId: presented.presentation.id, assessmentId: definition.id, assessmentVersion: definition.version, answer: { kind: 'numeric', value: '3/4', unit: '' } } });
  expect(answered.statusCode, answered.body).toBe(200); const attemptId = answered.json().attempt.attemptId;
  const exported = await artifact(session.id, 'study-pack');
  const shared = await app.inject({ method: 'POST', url: '/v1/share-links', headers: headers(), payload: { sessionId: session.id, expiresInDays: 1, includeNotes: false, includeCards: true } });
  expect(shared.statusCode, shared.body).toBe(200); const shareToken = shared.json().url.split('/').at(-1);
  expect((await app.inject({ url: `/v1/artifacts/${exported.id}/download`, headers: headers() })).statusCode).toBe(200);
  expect((await app.inject({ url: `/v1/shares/${shareToken}` })).statusCode).toBe(200);
  const appealed = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/attempts/${attemptId}/appeal`, headers: headers(), payload: { reason: 'Please reconsider the explanation behind this grading.' } });
  expect(appealed.statusCode, appealed.body).toBe(200);
  const study = (await store.resources.get<StudyPack>(p, 'study-pack', session.id)).data;
  expect(study.attempts[0]!.evaluation.correctness).toBe('uncertain');
  expect(study.mastery.every(item => item.independentSuccesses === 0)).toBe(true);
  expect(study.recommendations[0]).toContain('appealed'); expect(study.recap.text).toBe('');
  expect(study.cards.every(card => card.status === 'active')).toBe(true); // A grading appeal does not falsely mark source cards incorrect.
  expect((await app.inject({ url: `/v1/artifacts/${exported.id}/download`, headers: headers() })).statusCode).toBe(409);
  expect((await app.inject({ url: `/v1/shares/${shareToken}` })).statusCode).toBe(404);
});
