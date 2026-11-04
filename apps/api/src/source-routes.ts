import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { UploadIntentSchema, type Source, type Session, type Citation } from '@tokai/contracts';
import { StoreError, type Principal, type JobRecord } from '@tokai/db';
import { validateUpload, MAX_SOURCE_BYTES, ingestSource, embedQuery, EMBEDDING_MODEL } from '@tokai/grounding';
import { principal, parse, optionalResource, type ProductContext } from './product-context.js';
import { usesAccountCookie } from './identity.js';

type Params = { id: string };
const sourceKey = (id: string) => `source/${id}`;
const assertRawFileAvailable = (source: Source, now: string) => { if (source.fileExpiresAt && Date.parse(source.fileExpiresAt) <= Date.parse(now)) throw new StoreError(410, 'OBJECT_EXPIRED', 'This saved source file reached its retention limit. Indexed text remains available until its own retention ends.'); };
export async function registerSources(app: FastifyInstance, context: ProductContext) {
  const { store, objects, now, env } = context;
  // A separate parser scope prevents binary payloads from affecting JSON routes.
  await app.register(async uploads => {
    uploads.removeContentTypeParser('text/plain');
    uploads.addContentTypeParser(['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_SOURCE_BYTES }, (_request, body, done) => done(null, body));
    uploads.put<{ Params: Params }>('/v1/sources/:id/content', { bodyLimit: MAX_SOURCE_BYTES }, async (request, reply) => {
      const p = await principal(request, store), record = await store.resources.get<Source>(p, 'source', request.params.id);
      if (record.data.status !== 'awaiting-upload') throw new StoreError(409, 'UPLOAD_COMPLETE', 'This upload was already finalized.');
      if (Date.parse(record.createdAt) + 3600000 < Date.parse(now())) throw new StoreError(410, 'UPLOAD_EXPIRED', 'Start a new upload; this upload request expired.');
      if (!Buffer.isBuffer(request.body)) throw new StoreError(400, 'INVALID_UPLOAD', 'Upload the raw file bytes.');
      try { validateUpload(request.body, record.data.mimeType, record.data); } catch { throw new StoreError(400, 'INVALID_UPLOAD', 'The file content, size, format or checksum did not match the upload request.'); }
      await objects.put(sourceKey(record.id), request.body, record.data.mimeType, { principal: p, checksum: record.data.checksum, signal: AbortSignal.timeout(30000) });
      try { await store.resources.get(p, 'source', record.id); }
      catch (error) { await objects.delete(sourceKey(record.id)); throw error; }
      return reply.status(204).send();
    });
  });
  app.get('/v1/sources', async request => ({ sources: (await store.resources.list<Source>(await principal(request, store), 'source', { limit: 100 })).map(item => item.data) }));
  app.post('/v1/sources/uploads', async request => {
    const p = await principal(request, store), input = parse(UploadIntentSchema, request.body);
    const source = await store.locked(`owner:${p.ownerId}`, async () => {
      const existing = await store.resources.list<Source>(p, 'source', { limit: 100 });
      if (existing.length >= 30 || existing.reduce((sum, item) => sum + item.data.bytes, 0) + input.bytes > 100 * 1024 * 1024) throw new StoreError(429, 'SOURCE_LIMIT', 'Keep at most 30 sources and 100 MiB per learner. Delete unused uploads first.');
      const source: Source = { ...input, id: randomUUID(), status: 'awaiting-upload', revision: 0, createdAt: now(), updatedAt: now() };
      await store.resources.put(p, 'source', source.id, source, { expectedRevision: -1 });
      return source;
    });
    if (objects.createTransfer) { const transfer = await objects.createTransfer(p, { kind: 'source', id: source.id, operation: 'upload' }); return { source, uploadUrl: transfer.url, headers: transfer.headers, expiresAt: transfer.expiresAt }; }
    const headers: Record<string, string> = { 'Content-Type': source.mimeType };
    if (request.headers.authorization && !usesAccountCookie(request)) headers.Authorization = request.headers.authorization;
    return { source, uploadUrl: `${env.API_PUBLIC_URL ?? 'http://localhost:4000'}/v1/sources/${source.id}/content`, headers };
  });
  app.post<{ Params: Params }>('/v1/sources/:id/download-ticket', async (request, reply) => {
    const p = await principal(request, store), record = await store.resources.get<Source>(p, 'source', request.params.id); assertRawFileAvailable(record.data, now());
    return reply.header('Cache-Control', 'no-store').send({ transfer: objects.createTransfer ? await objects.createTransfer(p, { kind: 'source', id: request.params.id, operation: 'download' }) : null });
  });
  for (const operation of ['complete', 'retry'] as const) app.post<{ Params: Params }>(`/v1/sources/:id/${operation}`, async request => {
    const p = await principal(request, store), initial = await store.resources.get<Source>(p, 'source', request.params.id);
    const metadata = await objects.head(sourceKey(initial.id));
    if (metadata.size !== initial.data.bytes || metadata.checksum !== initial.data.checksum) throw new StoreError(400, 'UPLOAD_INCOMPLETE', 'Upload all file bytes before processing.');
    return store.locked(`source:${initial.id}`, async () => {
      const record = await store.resources.get<Source>(p, 'source', initial.id);
      if (['ready', 'processing', 'queued'].includes(record.data.status)) return { source: record.data };
      if (operation === 'retry' && record.data.status !== 'failed') throw new StoreError(409, 'SOURCE_NOT_FAILED', 'Only failed processing can be retried.');
      const source: Source = { ...record.data, status: 'queued', error: undefined, fileExpiresAt: metadata.expiresAt, revision: record.revision + 1, updatedAt: now() };
      const saved = await store.resources.put(p, 'source', record.id, source, { expectedRevision: record.revision });
      await store.outbox.enqueue(p, { id: randomUUID(), kind: 'source', resourceKind: 'source', resourceId: source.id, expectedRevision: saved.revision });
      return { source };
    });
  });
  app.get<{ Params: Params }>('/v1/sources/:id/download', async (request, reply) => {
    const p = await principal(request, store), record = await store.resources.get<Source>(p, 'source', request.params.id);
    assertRawFileAvailable(record.data, now());
    const result = await objects.get(sourceKey(record.id), { principal: p, maxBytes: MAX_SOURCE_BYTES });
    await store.resources.get(p, 'source', record.id);
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', `attachment; filename="source-${record.id}.${record.data.mimeType === 'application/pdf' ? 'pdf' : record.data.mimeType === 'text/plain' ? 'txt' : record.data.mimeType === 'image/png' ? 'png' : 'jpg'}"`).type(record.data.mimeType).send(result.body);
  });
  app.delete<{ Params: Params }>('/v1/sources/:id', async (request, reply) => {
    const p = await principal(request, store);
    await store.locked(`source:${request.params.id}`, async () => { await store.chunks.delete(p, request.params.id); await store.resources.delete(p, 'source', request.params.id); });
    await objects.delete(sourceKey(request.params.id));
    return reply.status(204).send();
  });
}
export async function runSource(context: ProductContext, p: Principal, job: JobRecord, signal: AbortSignal) {
  const { store, objects, now } = context, id = job.resourceId!;
  const record = await store.resources.get<Source>(p, 'source', id);
  if (record.revision !== job.expectedRevision) return;
  const file = await objects.get(sourceKey(id), { principal: p, maxBytes: MAX_SOURCE_BYTES, signal });
  validateUpload(file.body, record.data.mimeType, record.data);
  // Chunk revision equals the final ready resource revision, including atomic status write.
  const finalRevision = record.revision + 1;
  const result = await ingestSource({ bytes: file.body, mime: record.data.mimeType, sourceId: id, revision: finalRevision }, signal);
  signal.throwIfAborted();
  await store.locked(`source:${id}`, async () => {
    await store.assertJob({ id: job.id, workerId: job.workerId!, fence: job.fence });
    const currentJob = await store.outbox.get(job.id), current = await store.resources.get<Source>(p, 'source', id);
    if (!currentJob || currentJob.state !== 'running' || currentJob.fence !== job.fence || currentJob.workerId !== job.workerId || current.revision !== record.revision) throw new StoreError(409, 'STALE_JOB', 'Source processing was superseded.');
    await store.resources.put(p, 'source', id, { ...current.data, revision: finalRevision, status: 'ready', pages: result.pages, chunks: result.chunks.length, parserVersion: 'tokai-local-ocr-v1', embeddingModel: EMBEDDING_MODEL, updatedAt: now(), error: undefined }, { expectedRevision: current.revision });
    await store.chunks.replace(p, id, finalRevision, result.chunks);
  });
}
export async function retrieveSources(context: ProductContext, p: Principal, session: Session, text: string, signal?: AbortSignal): Promise<Citation[]> {
  const ids = session.settings?.sourceIds ?? []; if (!ids.length) return [];
  const records = await Promise.all(ids.map(id => optionalResource<Source>(context.store, p, 'source', id)));
  const available = records.filter(record => record?.data.status === 'ready').map(record => record!);
  if (!available.length) return [];
  // Keyword search remains usable if the local embedding model is temporarily unavailable.
  let embedding: number[] | undefined;
  try { embedding = await embedQuery(text, AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])); } catch { signal?.throwIfAborted(); }
  const hits = await context.store.chunks.search(p, { sourceIds: available.map(record => record.id), text, embedding, limit: 6 });
  return hits.flatMap(hit => {
    const source = available.find(record => record.id === hit.sourceId);
    if (!source || hit.revision !== source.revision) return [];
    return [{ id: `cite:${hit.id}`, sourceId: source.id, sourceVersion: hit.revision, title: source.data.title, page: hit.page, section: hit.anchor, snippet: hit.text.slice(0, 1200), chunkId: hit.id }];
  });
}
