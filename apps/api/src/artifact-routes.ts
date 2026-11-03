import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type Artifact, type StudyPack, type ShareLink, StudyPackSchema } from '@tokai/contracts';
import { StoreError } from '@tokai/db';
import { principal, parse, enqueueArtifact, type ProductContext } from './product-context.js';

type Params = { id: string };
type SharedRecord = ShareLink & { pack: StudyPack };
export type ArtifactFile = { storageKey: string; contentType: string; filename: string };
export async function registerArtifacts(app: FastifyInstance, context: ProductContext) {
  const { store, objects, now, env } = context;
  app.post<{ Params: Params }>('/v1/sessions/:id/artifacts', async request => {
    const p = await principal(request, store), input = parse(z.object({ kind: z.enum(['study-pack', 'recap', 'cards', 'export']), format: z.enum(['markdown', 'pdf', 'csv', 'json']).optional() }).strict(), request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(p, request.params.id);
      if (input.kind === 'recap' && !session.settings?.preferences.retainRecapAudio) throw new StoreError(409, 'AUDIO_CONSENT_REQUIRED', 'Enable saved recap audio for this lesson before generating it.');
      return { artifact: await enqueueArtifact(context, p, session, input.kind, input.format) };
    });
  });
  app.post<{ Params: Params }>('/v1/artifacts/:id/retry', async request => {
    const p = await principal(request, store);
    return store.locked(`artifact:${request.params.id}`, async () => {
      const record = await store.resources.get<Artifact>(p, 'artifact', request.params.id);
      await store.get(p, record.data.sessionId);
      if (record.data.status !== 'failed') throw new StoreError(409, 'ARTIFACT_NOT_FAILED', 'Only failed work can be retried.');
      const artifact: Artifact = { ...record.data, revision: record.data.revision + 1, status: 'queued', error: undefined, updatedAt: now() };
      const saved = await store.resources.put(p, 'artifact', artifact.id, artifact, { expectedRevision: record.revision, sessionId: artifact.sessionId });
      await store.outbox.enqueue(p, { id: randomUUID(), kind: 'artifact', sessionId: artifact.sessionId, resourceKind: 'artifact', resourceId: artifact.id, expectedRevision: saved.revision });
      return { artifact };
    });
  });
  app.get<{ Params: Params }>('/v1/artifacts/:id/download', async (request, reply) => {
    const p = await principal(request, store), record = await store.resources.get<Artifact>(p, 'artifact', request.params.id);
    if (record.data.status !== 'ready') throw new StoreError(409, 'ARTIFACT_NOT_READY', 'This download is not ready yet.');
    const file = await store.resources.get<ArtifactFile>(p, 'artifact-file', record.id), result = await objects.get(file.data.storageKey);
    const session = await store.get(p, record.data.sessionId), current = await store.resources.get<Artifact>(p, 'artifact', record.id), currentFile = await store.resources.get<ArtifactFile>(p, 'artifact-file', record.id);
    if (current.revision !== record.revision || current.data.status !== 'ready' || currentFile.revision !== file.revision || current.data.kind === 'recap' && !session.settings?.preferences.retainRecapAudio) throw new StoreError(409, 'DOWNLOAD_REVOKED', 'This download changed or its retention consent was withdrawn.');
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', `attachment; filename="${file.data.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`).type(file.data.contentType).send(result.body);
  });
  app.post('/v1/share-links', async request => {
    const p = await principal(request, store), input = parse(z.object({ sessionId: z.string().min(1).max(100), expiresInDays: z.number().int().min(1).max(30), includeNotes: z.boolean(), includeCards: z.boolean() }).strict(), request.body);
    return store.locked(input.sessionId, async () => {
      await store.get(p, input.sessionId);
      if ((await store.resources.list(p, 'share', { sessionId: input.sessionId, limit: 100 })).length >= 20) throw new StoreError(429, 'SHARE_LIMIT', 'This lesson already has twenty share links.');
      const study = await store.resources.get<StudyPack>(p, 'study-pack', input.sessionId);
      const token = randomBytes(32).toString('base64url'), id = createHash('sha256').update(token).digest('hex');
      const link: ShareLink = { id, sessionId: input.sessionId, createdAt: now(), expiresAt: new Date(Date.parse(now()) + input.expiresInDays * 86400000).toISOString(), revoked: false, includeNotes: input.includeNotes, includeCards: input.includeCards };
      const pack = shareProjection(study.data, input.includeNotes, input.includeCards);
      await store.resources.put(p, 'share', id, { ...link, pack } satisfies SharedRecord, { expectedRevision: -1, sessionId: input.sessionId });
      return { link, url: `${env.APP_ORIGIN ?? 'http://localhost:3000'}/share/${token}` };
    });
  });
  app.get<{ Querystring: { sessionId?: string } }>('/v1/share-links', async request => {
    const p = await principal(request, store);
    if (request.query.sessionId) await store.get(p, request.query.sessionId);
    return { links: (await store.resources.list<SharedRecord>(p, 'share', { sessionId: request.query.sessionId, limit: 100 })).map(({ data: { pack: _pack, ...link } }) => link) };
  });
  app.delete<{ Params: Params }>('/v1/share-links/:id', async (request, reply) => {
    const p = await principal(request, store), record = await store.resources.get<SharedRecord>(p, 'share', request.params.id);
    await store.resources.put(p, 'share', record.id, { ...record.data, revoked: true }, { expectedRevision: record.revision, sessionId: record.sessionId });
    return reply.status(204).send();
  });
  app.get<{ Params: { token: string } }>('/v1/shares/:token', async (request, reply) => {
    if (!/^[\w-]{43}$/.test(request.params.token)) throw new StoreError(404, 'NOT_FOUND', 'This share link is unavailable.');
    const result = await store.resolveShare(createHash('sha256').update(request.params.token).digest('hex'));
    if (!result) throw new StoreError(404, 'NOT_FOUND', 'This share link expired or was revoked.');
    return reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow').send({ pack: StudyPackSchema.parse((result.record.data as SharedRecord).pack) });
  });
}
/** Publish an explicit, fixed study reference, excluding private transcript and assessment history. */
export function shareProjection(input: StudyPack, includeNotes: boolean, includeCards: boolean): StudyPack {
  const pack = structuredClone(input);
  pack.completedNarration = []; pack.partialNarration = []; pack.attempts = []; pack.mastery = []; pack.unresolvedQuestions = [];
  pack.notes = includeNotes ? pack.notes : ''; pack.cards = includeCards ? pack.cards : [];
  pack.sourceRefs = pack.sourceRefs.filter(ref => Boolean(ref.url)).map(({ snippet: _snippet, ...ref }) => ref);
  pack.referenceConcepts = pack.referenceConcepts.map(concept => ({ ...concept, sourceRefs: concept.sourceRefs.filter(ref => Boolean(ref.url)).map(({ snippet: _snippet, ...ref }) => ref) }));
  pack.cards = pack.cards.map(card => ({ ...card, sourceRefs: card.sourceRefs.filter(ref => Boolean(ref.url)).map(({ snippet: _snippet, ...ref }) => ref) }));
  pack.recap = { text: '', status: 'not-requested', completedBeatIds: [] };
  return StudyPackSchema.parse(pack);
}
