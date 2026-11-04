import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CreateSessionSchema, SendMessageSchema, UpdateBoardSchema, SpeechRequestSchema, BoardTransactionSchema, MapUpdateSchema, ExplainImageSchema, TutorVoiceSchema, TUTOR_VOICES, applyMapUpdate, emptyConceptMap, type Session, type SelectionContext, type BoardCommand, type PracticeResponse, type SpeechLanguage } from '@milli/contracts';
import { createLesson, sampleTeachingReply, summarizeSession, generateTutorReply, fastProvidersFromEnv, generateVisionExplanation, validateVisionImage, groundSpatialSelection, VisionError, TutorError, type GenerateReply, type TutorReply } from '@milli/tutor-core';
import { synthesizeSpeech } from '@milli/speech';
import { ApiError, FileStore } from './store.js';
import { ConvexStore, NativeObjectStore, FileObjectStore, type Store, type ObjectStore, type Principal } from '@milli/db';
import { LearningError, getLessonPack } from '@milli/learning';
import { LearningProviderError } from '@milli/tutor-core/learning';
import { registerIdentity, type IdentityOptions } from './identity.js';
import { registerProduct } from './product-routes.js';
import { registerLearning } from './learning-routes.js';
import { registerSources, retrieveSources } from './source-routes.js';
import { registerJobs } from './jobs.js';
import { registerArtifacts } from './artifact-routes.js';
import { registerDictation } from './dictation.js';
import { registerCourse } from './course-routes.js';
import { UsageMeter, registerUsage } from './usage.js';
import { registerRequestLifecycle, requestSignal } from './request-lifecycle.js';
import { clientAddress } from './client-address.js';
import { revokeSavedTranscript } from './privacy.js';
import { initializeLearning, enqueueArtifact, preferences, optionalResource, type ProductContext, type ProductProviders } from './product-context.js';
import { prepareLearningTurn } from './tutor-learning.js';
import { VoiceManager, type VoiceOptions } from './voice.js';
import { applySessionBoardTransaction, sceneFailure } from './board-operations.js';
import { planTeachingBeats, appendTeachingBeats, commitBeatVisuals } from './teaching.js';

export type AppOptions = {
  dataDir?: string; now?: () => number; origin?: string;
  /** Build-time contract inventory; never receives request data or credentials. */
  routeObserver?: (route: { method: string | string[]; url: string; bodyLimit?: number }) => void;
  env?: Record<string, string | undefined>;
  tutor?: GenerateReply;
  speech?: typeof synthesizeSpeech;
  rateLimit?: boolean;
  voice?: VoiceOptions;
  vision?: typeof generateVisionExplanation;
  store?: Store; objects?: ObjectStore;
  learning?: ProductProviders;
  identity?: Pick<IdentityOptions, 'nativeIdentity'>;
};

export async function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const clock = options.now ?? Date.now;
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dataDir = options.dataDir ?? env.TOKAI_DATA_DIR ?? path.join(root, '.tokai');
  const useConvex = !options.dataDir && Boolean(env.CONVEX_URL);
  const store = options.store ?? (useConvex ? ConvexStore.fromEnv(env) : new FileStore(dataDir, clock));
  const objects = options.objects ?? (useConvex ? NativeObjectStore.fromEnv(env) : new FileObjectStore(path.join(dataDir, 'objects')));
  await store.initialize();
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 35000, trustProxy: false });
  if (options.routeObserver) app.addHook('onRoute', route => options.routeObserver!(route));
  registerRequestLifecycle(app);
  await app.register(cors, { origin: options.origin ?? env.APP_ORIGIN ?? 'http://localhost:3000', credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] });
  if (options.rateLimit !== false) await app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: request => clientAddress(request, env.VERCEL === '1') });
  const tutorConfigured = () => Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL) || fastProvidersFromEnv(env).length > 0;
  const providers = () => ({ tutor: tutorConfigured(), speech: Boolean(env.ASSEMBLYAI_API_KEY), voice: tutorConfigured() && Boolean(env.ASSEMBLYAI_API_KEY) });
  const usage = new UsageMeter(store, env, clock);
  const httpTurns = new Map<string, AbortController>();
  const voice = new VoiceManager({ store, env, usage, now: clock, tutor: options.tutor ?? generateTutorReply, tutorWithPrincipal: (input, p) => live(input.session, input.text, input.selectedNodeId, input.selection, input.signal, p, input.turnId ? { id: input.turnId, practiceResponse: input.practiceResponse, mode: input.inputMode ?? 'typed' } : undefined), voice: options.voice, origin: options.origin ?? env.APP_ORIGIN ?? 'http://localhost:3000', httpBusy: id => httpTurns.has(id) });
  const authenticate = (header: string | undefined) => store.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  const now = () => new Date(clock()).toISOString();
  const bump = (session: Session) => { session.revision++; session.updatedAt = now(); return session; };
  const ensureActive = (session: Session) => { if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'This lesson has ended. Start a new lesson to keep learning.'); };
  const parse = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'The request contains invalid or missing fields.');
    return result.data;
  };
  const product: ProductContext = { store, objects, env, usage, now, providers: { ...options.learning, speech: options.speech ?? options.learning?.speech }, closeSession: async id => { httpTurns.get(id)?.abort(); await voice.closeSession(id, 'Lesson access changed'); } };
  async function live(session: Session, text: string, selectedNodeId?: string, selection?: SelectionContext, signal?: AbortSignal, principal?: Principal, turn?: { id: string; practiceResponse?: PracticeResponse; mode: 'typed' | 'spoken' }) {
    if (!providers().tutor) throw new ApiError(503, 'TUTOR_UNAVAILABLE', 'Live AI is not configured. Choose a sample lesson or configure Gemini on the server.');
    if (!principal) throw new ApiError(401, 'UNAUTHORIZED', 'A learner session is required.');
    const learning = turn ? await prepareLearningTurn(product, principal, { session, text, turnId: turn.id, practiceResponse: turn.practiceResponse, mode: turn.mode, signal }) : undefined;
    if (learning?.answerReply) return learning.finalize(learning.answerReply);
    let modelCalls = 0;
    const generated = await usage.run(principal, 'model', 3, async observe => {
    const previousCitations = session.citations ?? [];
    if (principal && session.settings?.sourceIds.length) session.citations = await retrieveSources(product, principal, session, `${session.topic}: ${text}`, signal);
    try {
      if (session.settings?.grounding === 'sources-only' && !session.citations?.length) return { text: 'I could not find supporting material in the selected sources. Ask about a more specific passage, or add a source that covers this question.' };
      // The model sees only this turn's retrieval. Preserve prior references afterwards for saved learning material.
      modelCalls = 1;
      const result = await (options.tutor ?? generateTutorReply)({ session, text, selectedNodeId, selection, signal, learning: learning?.learning, onUsage: observe, limits: { requestTimeoutMs: 45000 }, apiKey: env.GEMINI_API_KEY ?? '', model: env.GEMINI_MODEL ?? '', fastProviders: fastProvidersFromEnv(env) });
      modelCalls = result.diagnostics?.modelCalls ?? modelCalls; return result;
    } finally {
      const citations = new Map(previousCitations.map(citation => [citation.id, citation]));
      for (const citation of session.citations ?? []) { citations.delete(citation.id); citations.set(citation.id, citation); }
      session.citations = [...citations.values()].slice(-80);
    }
    }, { sessionId: turn ? session.id : undefined, traceId: turn?.id ?? session.id, signal, usedUnits: () => modelCalls });
    return learning ? learning.finalize(generated) : generated;
  }
  function applyTextReply(session: Session, result: TutorReply, turnId: string) {
    const beats = planTeachingBeats(session, result, turnId, 0);
    appendTeachingBeats(session, beats, now(), false);
    for (const beat of beats) commitBeatVisuals(session, beat.beatId);
  }
  app.setErrorHandler((error, request, reply) => {
    const sendError = (status: number, code: string, message: string) => reply.status(status).send({ code, message, requestId: request.id, retryable: [429, 502, 503, 504].includes(status) && !/DAILY_|SESSION_LIMIT|SOURCE_LIMIT|TURN_LIMIT|PRACTICE_LIMIT|SHARE_LIMIT|CONFIGURATION|UNAVAILABLE/.test(code) });
    if (error instanceof LearningError) return sendError(/CONFLICT|SUBMITTED|INACTIVE/.test(error.code) ? 409 : 400, error.code, error.message);
    if (error instanceof ApiError || error instanceof TutorError || error instanceof LearningProviderError) return sendError(error.status, error.code, error.message);
    if (error instanceof VisionError) return sendError(error.code.startsWith('INVALID') || error.code === 'IMAGE_TOO_LARGE' ? 400 : 503, error.code, error.message);
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
    if (status === 429) return sendError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
    if (status && status >= 400 && status < 500) return sendError(status, 'INVALID_REQUEST', 'The request could not be accepted.');
    return sendError(500, 'INTERNAL_ERROR', 'The server could not complete the request. Reload the lesson before retrying.');
  });
  await registerIdentity(app, { ...options.identity, store, env, now: clock, closeOwner: async ownerId => { await voice.closeOwner(ownerId); for (const session of await store.list(await store.principalForOwner(ownerId)).catch(() => [])) await product.closeSession(session.id); } });
  registerUsage(app, store, usage);
  await voice.register(app);
  await registerSources(app, product);
  await registerLearning(app, product);
  await registerProduct(app, product, async (p, session, signal) => { applyTextReply(session, await live(session, 'Introduce this lesson briefly and ask one diagnostic question.', undefined, undefined, AbortSignal.any([AbortSignal.timeout(65000), ...(signal ? [signal] : [])]), p), `intro:${randomUUID()}`); });
  await registerArtifacts(app, product);
  await registerDictation(app, product, options.origin ?? env.APP_ORIGIN ?? 'http://localhost:3000');
  await registerCourse(app, product);
  await registerJobs(app, product);
  app.addHook('onClose', async () => { for (const controller of httpTurns.values()) controller.abort(); objects.close(); await store.close(); });
  app.get('/health/live', async () => ({ status: 'ok', providers: providers() }));
  app.get('/health/ready', async (_request, reply) => { const ready = await store.health() && await objects.health(); return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable', database: useConvex ? 'convex' : 'isolated-file' }); });
  app.post('/v1/guest-sessions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_request, reply) => reply.status(201).send(await store.createGuest()));
  app.get('/v1/sessions', async request => ({ sessions: await store.list(await authenticate(request.headers.authorization)) }));
  app.post('/v1/sessions', async (request, reply) => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(CreateSessionSchema, request.body);
    const session = createLesson({ ...input, id: randomUUID(), now: now(), messageId: randomUUID() });
    const savedPreferences = (await preferences(store, principal)).preferences, pack = getLessonPack(input.topic);
    session.settings = { preferences: input.mode === 'sample' ? { ...savedPreferences, language: 'english' } : savedPreferences, goal: session.title, sourceIds: [], grounding: 'general' };
    if (pack) session.plan = { version: 1, goal: session.title, level: savedPreferences.level, minutes: savedPreferences.lessonMinutes, objectives: pack.objectives.slice(0, 8).map(item => item.text), prerequisites: pack.prerequisites.slice(0, 8), steps: pack.objectives.slice(0, 8).map(item => ({ title: item.text.slice(0, 120), objective: item.text })), provenance: 'authored', status: 'ready' };
    if (session.mode === 'live') { session.messages = []; applyTextReply(session, await live(session, 'Introduce this lesson with a short explanation and one diagnostic question.', undefined, undefined, AbortSignal.any([requestSignal(request), AbortSignal.timeout(65000)]), principal), `intro:${randomUUID()}`); }
    await store.locked(`owner:${principal.hash}`, async () => {
      if ((await store.list(principal)).length >= 30) throw new ApiError(429, 'SESSION_LIMIT', 'This guest has reached 30 lessons. Delete a saved lesson before starting another.');
      await store.create(principal, session);
      await initializeLearning(product, principal, session);
    });
    return reply.status(201).send({ session });
  });
  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async request => ({ session: await store.get(await authenticate(request.headers.authorization), request.params.id) }));
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/messages', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(SendMessageSchema, request.body);
    const requestHash = createHash('sha256').update(JSON.stringify({ ...input, requestId: undefined })).digest('hex');
    const turnId = `text:${input.requestId ? createHash('sha256').update(`${principal.ownerId}:${request.params.id}:${input.requestId}`).digest('hex').slice(0, 48) : randomUUID()}`;
    let duplicate = false;
    const controller = new AbortController();
    const context = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id);
      const receipt = await optionalResource<{ hash: string }>(store, principal, 'http-turn', turnId);
      if (receipt) { if (receipt.data.hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request identifier already belongs to a different question.'); duplicate = true; return session; }
      ensureActive(session);
      await voice.assertHttpAvailable(session.id, principal);
      if (httpTurns.has(session.id)) throw new ApiError(409, 'TURN_ACTIVE', 'Wait for the current tutor response before sending another message.');
      if (session.messages.length > 198 || (session.teachingBeats?.length ?? 0) > 198) throw new ApiError(429, 'TURN_LIMIT', 'This lesson has reached its message limit. Finish it and start a new lesson.');
      if (input.selectedNodeId && !session.board.nodes.some(node => node.id === input.selectedNodeId)) throw new ApiError(400, 'INVALID_SELECTION', 'The selected board item is no longer available. Select it again.');
      groundSpatialSelection(input.selection?.spatial);
      httpTurns.set(session.id, controller); return session;
    });
    if (duplicate) return { session: context };
    try {
      const signal = AbortSignal.any([controller.signal, requestSignal(request)]);
      let result: TutorReply;
      if (context.mode === 'sample' && input.practiceResponse) {
        const learning = await prepareLearningTurn(product, principal, { session: context, text: input.text, turnId, practiceResponse: input.practiceResponse, mode: 'typed', signal });
        result = await learning.finalize(learning.answerReply!);
      } else result = context.mode === 'sample' ? sampleTeachingReply(context, input.text, input.selectedNodeId, input.selection) : await live(context, input.text, input.selectedNodeId, input.selection, signal, principal, { id: turnId, practiceResponse: input.practiceResponse, mode: 'typed' });
      // Plan against the model's immutable input. A later student board edit causes
      // only the stale visual transaction to fail, never a whole-board overwrite.
      const planned = planTeachingBeats(context, result, turnId, 0);
      return await store.locked(request.params.id, async () => {
        const session = await store.get(principal, request.params.id); ensureActive(session);
        const receipt = await optionalResource<{ hash: string }>(store, principal, 'http-turn', turnId);
        if (receipt) { if (receipt.data.hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request identifier already belongs to a different question.'); return { session }; }
        await voice.assertHttpAvailable(session.id, principal);
        if (signal.aborted) throw new ApiError(409, 'TURN_CANCELLED', 'The lesson changed before that answer could be saved.');
        session.messages.push({ id: randomUUID(), role: 'student', text: input.text, turnId, createdAt: now() });
        if (context.citations) session.citations = context.citations;
        appendTeachingBeats(session, planned, now(), false);
        for (const beat of planned) { await result.commitLearning?.(session, beat.beatId); commitBeatVisuals(session, beat.beatId); }
        if (signal.aborted) throw new ApiError(409, 'TURN_CANCELLED', 'The lesson changed before that answer could be saved.');
        await store.resources.put(principal, 'http-turn', turnId, { hash: requestHash }, { expectedRevision: -1, sessionId: session.id });
        await store.save(principal, bump(session));
        if (signal.aborted) throw new ApiError(409, 'TURN_CANCELLED', 'The lesson changed before that answer could be saved.');
        return { session };
      });
    } finally { if (httpTurns.get(request.params.id) === controller) httpTurns.delete(request.params.id); }
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/board-operations', async request => {
    const principal = await authenticate(request.headers.authorization), transaction = parse(BoardTransactionSchema, request.body);
    const committed = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      const result = applySessionBoardTransaction(session, transaction, 'student');
      if (!result.duplicate) await store.save(principal, bump(session));
      return { session };
    });
    voice.publishBoard(committed.session, transaction.operationId); return committed;
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id/map', async request => {
    const principal = await authenticate(request.headers.authorization), update = parse(MapUpdateSchema, request.body);
    const committed = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      if (update.nodes.some(node => node.boardNodeIds?.some(id => !session.board.nodes.some(shape => shape.id === id)) || node.messageIds?.some(id => !session.messages.some(message => message.id === id)) || node.cardIds?.some(id => !session.flashcards.some(card => card.id === id)))) throw new ApiError(400, 'INVALID_MAP_REFERENCE', 'Concept-map links must reference this lesson.');
      try { session.conceptMap = applyMapUpdate(session.conceptMap ?? emptyConceptMap(session.topic), update, 'student'); } catch (error) { throw sceneFailure(error); }
      await store.save(principal, bump(session)); return { session };
    });
    voice.publishBoard(committed.session, `map:${randomUUID()}`); return committed;
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/explain-image', { bodyLimit: 1500000, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    const principal = await authenticate(request.headers.authorization), input = parse(ExplainImageSchema, request.body);
    validateVisionImage(input.image);
    const controller = new AbortController();
    const context = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session); await voice.assertHttpAvailable(session.id, principal);
      if (session.mode !== 'live' || !env.GEMINI_API_KEY || !env.GEMINI_MODEL) throw new ApiError(503, 'VISION_UNAVAILABLE', 'Board-image explanations require a configured live AI lesson.');
      if (session.messages.length > 198 || (session.teachingBeats?.length ?? 0) > 198) throw new ApiError(429, 'TURN_LIMIT', 'Finish this lesson before asking another image question.');
      if (httpTurns.has(session.id)) throw new ApiError(409, 'TURN_ACTIVE', 'Wait for the current tutor response.');
      httpTurns.set(session.id, controller); return session;
    });
    try {
      const signal = AbortSignal.any([controller.signal, requestSignal(request)]);
      const result = await usage.run(principal, 'model', 1, observe => (options.vision ?? generateVisionExplanation)({ ...input, session: context, apiKey: env.GEMINI_API_KEY!, model: env.VISION_MODEL ?? env.GEMINI_MODEL!, signal, onUsage: observe }), { sessionId: context.id, model: env.VISION_MODEL ?? env.GEMINI_MODEL!, signal });
      return await store.locked(request.params.id, async () => {
        const session = await store.get(principal, request.params.id); ensureActive(session);
        await voice.assertHttpAvailable(session.id, principal);
        if (signal.aborted) throw new ApiError(409, 'TURN_CANCELLED', 'The image explanation was cancelled.');
        const turnId = `vision:${randomUUID()}`;
        session.messages.push({ id: randomUUID(), role: 'student', text: `${input.text}\n[Shared a board crop for this explanation only.]`, turnId, createdAt: now() });
        applyTextReply(session, result, turnId); await store.save(principal, bump(session)); return { session };
      });
    } finally { if (httpTurns.get(request.params.id) === controller) httpTurns.delete(request.params.id); }
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id/board', async request => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(UpdateBoardSchema, request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      await voice.assertHttpAvailable(session.id, principal);
      if (session.revision !== input.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'The lesson changed. Reload its latest board and try again.');
      const commands: BoardCommand[] = [];
      for (const edge of session.board.edges) if (!input.board.edges.some(value => value.id === edge.id)) commands.push({ type: 'remove_edge', id: edge.id });
      for (const node of session.board.nodes) if (!input.board.nodes.some(value => value.id === node.id)) commands.push({ type: 'remove_node', id: node.id });
      for (const frame of input.board.frames ?? []) if (JSON.stringify(frame) !== JSON.stringify(session.board.frames?.find(value => value.id === frame.id))) commands.push({ type: 'upsert_frame', frame });
      for (const node of input.board.nodes) if (JSON.stringify(node) !== JSON.stringify(session.board.nodes.find(value => value.id === node.id))) commands.push({ type: 'upsert_node', node });
      for (const edge of input.board.edges) if (JSON.stringify(edge) !== JSON.stringify(session.board.edges.find(value => value.id === edge.id))) commands.push({ type: 'upsert_edge', edge });
      for (const frame of session.board.frames ?? []) if (!input.board.frames?.some(value => value.id === frame.id)) commands.push({ type: 'remove_frame', id: frame.id });
      if (commands.length) applySessionBoardTransaction(session, { operationId: `legacy:${randomUUID()}`, expectedRevision: session.board.revision ?? 0, commands }, 'student');
      await store.save(principal, bump(session)); return { session };
    });
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/end', async request => {
    const principal = await authenticate(request.headers.authorization);
    await store.get(principal, request.params.id);
    httpTurns.get(request.params.id)?.abort();
    await voice.closeSession(request.params.id, 'Lesson ended');
    const result = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id);
      const files: string[] = [];
      if (session.status !== 'ended') {
        session.status = 'ended'; session.summary = summarizeSession(session);
        if (session.settings?.preferences.retainTranscript === false) files.push(...await revokeSavedTranscript(product, principal, session));
        await store.save(principal, bump(session)); await enqueueArtifact(product, principal, session, 'study-pack');
      }
      return { session, files };
    });
    for (const key of result.files) await objects.delete(key);
    return { session: result.session };
  });
  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    const principal = await authenticate(request.headers.authorization);
    await store.get(principal, request.params.id);
    httpTurns.get(request.params.id)?.abort();
    await voice.closeSession(request.params.id, 'Lesson deleted');
    await store.locked(request.params.id, () => store.delete(principal, request.params.id)); return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/speech', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(SpeechRequestSchema, request.body);
    {
      const session = await store.get(principal, request.params.id);
      await voice.assertHttpAvailable(session.id, principal);
      const message = session.messages.find(message => message.id === input.messageId && message.role === 'tutor');
      if (!message) throw new ApiError(404, 'NOT_FOUND', 'Tutor message not found.');
      if (!env.ASSEMBLYAI_API_KEY) throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'AssemblyAI speech is not configured on the server.');
      try {
        const result = await usage.run(principal, 'speech', [...message.text].length, () => (options.speech ?? synthesizeSpeech)({ text: message.text, apiKey: env.ASSEMBLYAI_API_KEY!, voiceId: session.settings?.preferences.voiceId ?? env.ASSEMBLYAI_VOICE_ID, language: session.settings?.preferences.language, signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(25000)]) }), { sessionId: session.id });
        await store.get(principal, session.id);
        return reply.type(result.contentType).header('Cache-Control', 'no-store').send(result.audio);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'SPEECH_FAILED', 'Speech is temporarily unavailable. The text lesson is still available.');
      }
    }
  });
  app.post<{ Params: { voiceId: string } }>('/v1/voices/:voiceId/preview', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const principal = await authenticate(request.headers.authorization);
    const voiceId = parse(TutorVoiceSchema, request.params.voiceId), voice = TUTOR_VOICES.find(item => item.id === voiceId)!;
    if (!env.ASSEMBLYAI_API_KEY) throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'AssemblyAI speech is not configured on the server.');
    const text = VOICE_PREVIEW_TEXT[voice.language];
    try {
      const result = await usage.run(principal, 'speech', [...text].length, () => (options.speech ?? synthesizeSpeech)({ text, apiKey: env.ASSEMBLYAI_API_KEY!, voiceId, language: voice.language, signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(20000)]) }));
      return reply.type(result.contentType).header('Cache-Control', 'no-store').send(result.audio);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'SPEECH_FAILED', 'Voice preview is temporarily unavailable.');
    }
  });
  return app;
}
const VOICE_PREVIEW_TEXT: Record<SpeechLanguage, string> = {
  english: 'Hi, I’m milli. Ask me anything, and we’ll figure it out together.',
  spanish: 'Hola, soy milli. Pregúntame lo que quieras y lo resolvemos juntos.',
  german: 'Hallo, ich bin milli. Frag mich alles, und wir finden es gemeinsam heraus.',
  french: 'Bonjour, je suis milli. Pose-moi une question, et on trouvera ensemble.',
  italian: 'Ciao, sono milli. Chiedimi qualsiasi cosa e lo scopriremo insieme.',
  portuguese: 'Olá, eu sou a milli. Pergunte o que quiser e vamos descobrir juntos.',
};
