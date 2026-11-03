import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CreateSessionSchema, SendMessageSchema, UpdateBoardSchema, SpeechRequestSchema, BoardTransactionSchema, MapUpdateSchema, ExplainImageSchema, applyMapUpdate, emptyConceptMap, type Session, type SelectionContext, type BoardCommand } from '@tokai/contracts';
import { createLesson, sampleTeachingReply, summarizeSession, generateTutorReply, generateVisionExplanation, validateVisionImage, groundSpatialSelection, VisionError, TutorError, type GenerateReply, type TutorReply } from '@tokai/tutor-core';
import { synthesizeSpeech } from '@tokai/speech';
import { ApiError, FileStore } from './store.js';
import { VoiceManager, type VoiceOptions } from './voice.js';
import { applySessionBoardTransaction, sceneFailure } from './board-operations.js';
import { planTeachingBeats, appendTeachingBeats, commitBeatVisuals } from './teaching.js';

export type AppOptions = {
  dataDir?: string; now?: () => number; origin?: string;
  env?: Record<string, string | undefined>;
  tutor?: GenerateReply;
  speech?: typeof synthesizeSpeech;
  rateLimit?: boolean;
  voice?: VoiceOptions;
  vision?: typeof generateVisionExplanation;
};

export async function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const clock = options.now ?? Date.now;
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const store = new FileStore(options.dataDir ?? env.TOKAI_DATA_DIR ?? path.join(root, '.tokai'), clock);
  await store.initialize();
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 35000, trustProxy: false });
  await app.register(cors, { origin: options.origin ?? env.APP_ORIGIN ?? 'http://localhost:3000', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] });
  if (options.rateLimit !== false) await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  const providers = () => ({ tutor: Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL), speech: Boolean(env.ASSEMBLYAI_API_KEY), voice: Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL && env.ASSEMBLYAI_API_KEY) });
  const httpTurns = new Map<string, AbortController>();
  const voice = new VoiceManager({ store, env, now: clock, tutor: options.tutor ?? generateTutorReply, voice: options.voice, origin: options.origin ?? env.APP_ORIGIN ?? 'http://localhost:3000', httpBusy: id => httpTurns.has(id) });
  const authenticate = (header: string | undefined) => store.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  const now = () => new Date(clock()).toISOString();
  const bump = (session: Session) => { session.revision++; session.updatedAt = now(); return session; };
  const ensureActive = (session: Session) => { if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'This lesson has ended. Start a new lesson to keep learning.'); };
  const parse = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'The request contains invalid or missing fields.');
    return result.data;
  };
  async function live(session: Session, text: string, selectedNodeId?: string, selection?: SelectionContext, signal?: AbortSignal) {
    if (!providers().tutor) throw new ApiError(503, 'TUTOR_UNAVAILABLE', 'Live AI is not configured. Choose a sample lesson or configure Gemini on the server.');
    return (options.tutor ?? generateTutorReply)({ session, text, selectedNodeId, selection, signal, apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL! });
  }
  function applyTextReply(session: Session, result: TutorReply, turnId: string) {
    const beats = planTeachingBeats(session, result, turnId, 0);
    appendTeachingBeats(session, beats, now(), false);
    for (const beat of beats) commitBeatVisuals(session, beat.beatId);
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError || error instanceof TutorError) return reply.status(error.status).send({ code: error.code, message: error.message, requestId: request.id });
    if (error instanceof VisionError) return reply.status(error.code.startsWith('INVALID') || error.code === 'IMAGE_TOO_LARGE' ? 400 : 503).send({ code: error.code, message: error.message, requestId: request.id });
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
    if (status === 429) return reply.status(429).send({ code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.', requestId: request.id });
    if (status && status >= 400 && status < 500) return reply.status(status).send({ code: 'INVALID_REQUEST', message: 'The request could not be accepted.', requestId: request.id });
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'The server could not complete the request. Your saved lesson is unchanged.', requestId: request.id });
  });
  await voice.register(app);
  app.get('/health/live', async () => ({ status: 'ok', providers: providers() }));
  app.post('/v1/guest-sessions', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (_request, reply) => reply.status(201).send(await store.createGuest()));
  app.get('/v1/sessions', async request => ({ sessions: await store.list(await authenticate(request.headers.authorization)) }));
  app.post('/v1/sessions', async (request, reply) => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(CreateSessionSchema, request.body);
    return store.locked(`owner:${principal.hash}`, async () => {
      if ((await store.list(principal)).length >= 30) throw new ApiError(429, 'SESSION_LIMIT', 'This guest has reached 30 lessons. Delete a saved lesson before starting another.');
      const session = createLesson({ ...input, id: randomUUID(), now: now(), messageId: randomUUID() });
      if (session.mode === 'live') {
        session.messages = [];
        const result = await live(session, 'Introduce this lesson with a short explanation and one diagnostic question.');
        applyTextReply(session, result, `intro:${randomUUID()}`);
      }
      await store.save(principal, session);
      return reply.status(201).send({ session });
    });
  });
  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async request => ({ session: await store.get(await authenticate(request.headers.authorization), request.params.id) }));
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/messages', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(SendMessageSchema, request.body);
    const controller = new AbortController();
    const context = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      voice.assertHttpAvailable(session.id);
      if (httpTurns.has(session.id)) throw new ApiError(409, 'TURN_ACTIVE', 'Wait for the current tutor response before sending another message.');
      if (session.messages.length > 198 || (session.teachingBeats?.length ?? 0) > 198) throw new ApiError(429, 'TURN_LIMIT', 'This lesson has reached its message limit. Finish it and start a new lesson.');
      if (input.selectedNodeId && !session.board.nodes.some(node => node.id === input.selectedNodeId)) throw new ApiError(400, 'INVALID_SELECTION', 'The selected board item is no longer available. Select it again.');
      groundSpatialSelection(input.selection?.spatial);
      httpTurns.set(session.id, controller); return session;
    });
    try {
      const result = context.mode === 'sample' ? sampleTeachingReply(context, input.text, input.selectedNodeId, input.selection) : await live(context, input.text, input.selectedNodeId, input.selection, controller.signal);
      // Plan against the model's immutable input. A later student board edit causes
      // only the stale visual transaction to fail, never a whole-board overwrite.
      const turnId = `text:${randomUUID()}`, planned = planTeachingBeats(context, result, turnId, 0);
      return await store.locked(request.params.id, async () => {
        const session = await store.get(principal, request.params.id); ensureActive(session);
        if (controller.signal.aborted) throw new ApiError(409, 'TURN_CANCELLED', 'The lesson changed before that answer could be saved.');
        session.messages.push({ id: randomUUID(), role: 'student', text: input.text, turnId, createdAt: now() });
        appendTeachingBeats(session, planned, now(), false);
        for (const beat of planned) commitBeatVisuals(session, beat.beatId);
        await store.save(principal, bump(session)); return { session };
      });
    } finally { if (httpTurns.get(request.params.id) === controller) httpTurns.delete(request.params.id); }
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/board-operations', async request => {
    const principal = await authenticate(request.headers.authorization), transaction = parse(BoardTransactionSchema, request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      const result = applySessionBoardTransaction(session, transaction, 'student');
      if (!result.duplicate) await store.save(principal, bump(session));
      voice.publishBoard(session, transaction.operationId); return { session };
    });
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id/map', async request => {
    const principal = await authenticate(request.headers.authorization), update = parse(MapUpdateSchema, request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      if (update.nodes.some(node => node.boardNodeIds?.some(id => !session.board.nodes.some(shape => shape.id === id)) || node.messageIds?.some(id => !session.messages.some(message => message.id === id)) || node.cardIds?.some(id => !session.flashcards.some(card => card.id === id)))) throw new ApiError(400, 'INVALID_MAP_REFERENCE', 'Concept-map links must reference this lesson.');
      try { session.conceptMap = applyMapUpdate(session.conceptMap ?? emptyConceptMap(session.topic), update, 'student'); } catch (error) { throw sceneFailure(error); }
      await store.save(principal, bump(session)); voice.publishBoard(session, `map:${randomUUID()}`); return { session };
    });
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/explain-image', { bodyLimit: 1500000, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    const principal = await authenticate(request.headers.authorization), input = parse(ExplainImageSchema, request.body);
    validateVisionImage(input.image);
    const controller = new AbortController();
    const context = await store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session); voice.assertHttpAvailable(session.id);
      if (session.mode !== 'live' || !providers().tutor) throw new ApiError(503, 'VISION_UNAVAILABLE', 'Board-image explanations require a configured live AI lesson.');
      if (session.messages.length > 198 || (session.teachingBeats?.length ?? 0) > 198) throw new ApiError(429, 'TURN_LIMIT', 'Finish this lesson before asking another image question.');
      if (httpTurns.has(session.id)) throw new ApiError(409, 'TURN_ACTIVE', 'Wait for the current tutor response.');
      httpTurns.set(session.id, controller); return session;
    });
    try {
      const result = await (options.vision ?? generateVisionExplanation)({ ...input, session: context, apiKey: env.GEMINI_API_KEY!, model: env.VISION_MODEL ?? env.GEMINI_MODEL!, signal: controller.signal });
      return await store.locked(request.params.id, async () => {
        const session = await store.get(principal, request.params.id); ensureActive(session);
        if (controller.signal.aborted) throw new ApiError(409, 'TURN_CANCELLED', 'The image explanation was cancelled.');
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
      voice.assertHttpAvailable(session.id);
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
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id);
      if (session.status !== 'ended') { session.status = 'ended'; session.summary = summarizeSession(session); await store.save(principal, bump(session)); }
      return { session };
    });
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
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id);
      voice.assertHttpAvailable(session.id);
      const message = session.messages.find(message => message.id === input.messageId && message.role === 'tutor');
      if (!message) throw new ApiError(404, 'NOT_FOUND', 'Tutor message not found.');
      if (!env.ASSEMBLYAI_API_KEY) throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'AssemblyAI speech is not configured on the server.');
      try {
        const result = await (options.speech ?? synthesizeSpeech)({ text: message.text, apiKey: env.ASSEMBLYAI_API_KEY, voiceId: env.ASSEMBLYAI_VOICE_ID, signal: AbortSignal.timeout(25000) });
        store.assertPrincipal(principal);
        return reply.type(result.contentType).header('Cache-Control', 'no-store').send(result.audio);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'SPEECH_FAILED', 'Speech is temporarily unavailable. The text lesson is still available.');
      }
    });
  });
  return app;
}
