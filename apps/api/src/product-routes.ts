import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LearnerPreferencesSchema, CreateLessonSchema, SessionEditSchema, NoteUpdateSchema, type Session, type Source, type Artifact } from '@tokai/contracts';
import type { ArtifactFile } from './artifact-routes.js';
import { StoreError, type Principal } from '@tokai/db';
import { createLesson } from '@tokai/tutor-core';
import { generateLessonPlan } from '@tokai/tutor-core/learning';
import { getLessonPack } from '@tokai/learning';
import { clearIdentityCookies } from './identity.js';
import { retrieveSources } from './source-routes.js';
import { revokeSavedTranscript } from './privacy.js';
import { principal, parse, preferences, bumpSession, initializeLearning, enqueueArtifact, type ProductContext } from './product-context.js';

export async function registerProduct(app: FastifyInstance, context: ProductContext, introduce: (p: Principal, session: Session) => Promise<void>) {
  const { store, env, now } = context;
  app.get('/v1/me/preferences', async request => preferences(store, await principal(request, store)));
  app.patch('/v1/me/preferences', async request => {
    const p = await principal(request, store), input = parse(z.object({ preferences: LearnerPreferencesSchema, revision: z.number().int().min(-1) }).strict(), request.body);
    const record = await store.resources.put(p, 'preferences', p.ownerId, input.preferences, { expectedRevision: input.revision });
    return { preferences: record.data, revision: record.revision };
  });
  app.post('/v1/lessons', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = await principal(request, store), input = parse(CreateLessonSchema, request.body), pack = getLessonPack(input.topic);
    if (input.mode === 'sample' && !pack) throw new StoreError(400, 'SAMPLE_TOPIC', 'Prepared samples are available for the four library topics. Choose Live AI for a custom topic.');
    if (input.grounding === 'sources-only' && !input.sourceIds.length) throw new StoreError(400, 'SOURCES_REQUIRED', 'Select a ready source for source-only teaching.');
    if (input.mode === 'sample' && input.sourceIds.length) throw new StoreError(400, 'SAMPLE_GROUNDING', 'Prepared samples use their authored references. Choose Live AI to teach from uploads.');
    const sources = await Promise.all(input.sourceIds.map(id => store.resources.get<Source>(p, 'source', id)));
    if (sources.some(source => source.data.status !== 'ready')) throw new StoreError(409, 'SOURCES_NOT_READY', 'Wait for every selected source to finish processing.');
    const settings = { preferences: input.preferences ?? (await preferences(store, p)).preferences, goal: input.goal || input.topic, sourceIds: [...new Set(input.sourceIds)], grounding: input.grounding };
    if (input.mode === 'sample') settings.preferences = { ...settings.preferences, language: 'english' };
    const session = createLesson({ ...input, id: randomUUID(), now: now(), messageId: randomUUID() }); session.settings = settings;
    if (settings.grounding === 'sources-only') {
      session.messages = []; session.board = { revision: 0, nodes: [], edges: [], frames: [] };
      session.concepts = []; session.flashcards = [];
      session.conceptMap = { topicId: session.topic, revision: 0, nodes: [], edges: [] };
      session.lessonFocus = { goal: settings.goal, nextStep: 'Ask a short diagnostic question grounded in the selected material.', phase: 'diagnose' };
    }
    if (settings.sourceIds.length) session.citations = await retrieveSources(context, p, session, `${input.topic} ${settings.goal}`, AbortSignal.timeout(20000));
    if (pack && input.grounding !== 'sources-only') session.plan = { version: 1, goal: settings.goal, level: settings.preferences.level, minutes: settings.preferences.lessonMinutes, objectives: pack.objectives.slice(0, 8).map(item => item.text), prerequisites: pack.prerequisites.slice(0, 8), steps: pack.objectives.slice(0, 8).map(item => ({ title: item.text.slice(0, 120), objective: item.text })), provenance: 'authored', status: 'ready' };
    else {
      if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL) throw new StoreError(503, 'TUTOR_UNAVAILABLE', 'Configure Gemini to plan a custom lesson. Prepared samples remain available.');
      session.plan = await (context.providers?.plan ?? generateLessonPlan)({ topic: input.topic, settings, sourceRefs: session.citations?.map(citation => ({ ...citation, id: undefined, sourceVersion: String(citation.sourceVersion), snippet: citation.snippet.slice(0, 500) })).map(({ id: _id, ...citation }) => citation), apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, signal: AbortSignal.timeout(45000) });
    }
    if (session.mode === 'live') { session.messages = []; await introduce(p, session); }
    await store.locked(`owner:${p.ownerId}`, async () => {
      if ((await store.list(p)).length >= 100) throw new StoreError(429, 'SESSION_LIMIT', 'Delete unused lessons before creating more than 100.');
      for (const source of sources) await store.resources.get(p, 'source', source.id);
      await store.create(p, session); await initializeLearning(context, p, session);
      await store.appendEvent(p, session.id, { id: randomUUID(), type: 'lesson.created' });
    });
    return reply.status(201).send({ session });
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id', async request => {
    const p = await principal(request, store), input = parse(SessionEditSchema, request.body);
    return store.locked(request.params.id, async () => {
      const session = bumpSession({ ...await store.get(p, request.params.id), ...input }, now()); await store.save(p, session); return { session };
    });
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/resume', async request => {
    const p = await principal(request, store);
    return store.locked(request.params.id, async () => {
      const old = await store.get(p, request.params.id); if (old.status === 'active') return { session: old };
      const session = bumpSession({ ...old, status: 'active', archived: false }, now()); await store.save(p, session); return { session };
    });
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id/notes', async request => {
    const p = await principal(request, store), input = parse(NoteUpdateSchema, request.body);
    return store.locked(request.params.id, async () => {
      const old = await store.get(p, request.params.id);
      if (old.revision !== input.revision) throw new StoreError(409, 'VERSION_CONFLICT', 'The lesson changed. Reload before saving notes.');
      const session = bumpSession({ ...old, notes: input.notes }, now()); await store.save(p, session); return { session };
    });
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id/privacy', async request => {
    const p = await principal(request, store), input = parse(z.object({ revision: z.number().int().nonnegative(), retainTranscript: z.boolean().optional(), retainRecapAudio: z.boolean().optional(), retentionDays: z.number().int().min(1).max(365).optional() }).strict(), request.body);
    const result = await store.locked(request.params.id, async () => {
      const old = await store.get(p, request.params.id);
      if (old.revision !== input.revision) throw new StoreError(409, 'VERSION_CONFLICT', 'The lesson changed. Reload before changing its privacy preferences.');
      const { revision: _, ...privacy } = input, settings = old.settings ?? { preferences: (await preferences(store, p)).preferences, goal: old.lessonFocus?.goal ?? old.title, sourceIds: [], grounding: 'general' as const };
      const session = bumpSession({ ...old, settings: { ...settings, preferences: { ...settings.preferences, ...privacy } } }, now());
      const files: string[] = [];
      if (input.retainTranscript === false && session.status === 'ended') files.push(...await revokeSavedTranscript(context, p, session));
      await store.save(p, session);
      if (input.retainRecapAudio === false) for (const artifact of await store.resources.list<Artifact>(p, 'artifact', { sessionId: session.id, limit: 100 })) if (artifact.data.kind === 'recap') {
        const file = await store.resources.get<ArtifactFile>(p, 'artifact-file', artifact.id).catch(error => { if (error instanceof StoreError && error.status === 404) return undefined; throw error; });
        if (file) files.push(file.data.storageKey);
        await store.resources.put(p, 'artifact', artifact.id, { ...artifact.data, status: 'failed', revision: artifact.data.revision + 1, updatedAt: now(), error: 'Saved recap audio was disabled for this lesson.', captions: undefined, durationMs: undefined }, { expectedRevision: artifact.revision, sessionId: session.id });
      }
      if (input.retainTranscript === false && session.status === 'ended') await enqueueArtifact(context, p, session, 'study-pack');
      return { session, files };
    });
    for (const key of new Set(result.files)) await context.objects.delete(key);
    return { session: result.session };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/v1/sessions/:id/events', async request => {
    const after = Number(request.query.after ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new StoreError(400, 'INVALID_CURSOR', 'Use a nonnegative event cursor.');
    return { events: await store.events(await principal(request, store), request.params.id, after, 100) };
  });
  app.delete('/v1/me', async (request, reply) => {
    const p = await principal(request, store), sessions = await store.list(p), sources = await store.resources.list(p, 'source', { limit: 100 }), artifacts = await store.resources.list<{ storageKey: string }>(p, 'artifact-file', { limit: 1000 });
    for (const session of sessions) await context.closeSession(session.id);
    await store.deleteOwner(p);
    // Metadata tombstones close access first; bytes can no longer be downloaded while cleanup runs.
    for (const source of sources) await context.objects.delete(`source/${source.id}`);
    for (const artifact of artifacts) await context.objects.delete(artifact.data.storageKey);
    clearIdentityCookies(reply, env); return reply.status(204).send();
  });
}
