import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CreateSessionSchema, SendMessageSchema, UpdateBoardSchema, SpeechRequestSchema, type Session } from '@tokai/contracts';
import { createLesson, sampleReply, summarizeSession, generateTutorReply, TutorError, type GenerateReply } from '@tokai/tutor-core';
import { synthesizeSpeech } from '@tokai/speech';
import { ApiError, FileStore } from './store.js';
import { VoiceManager, type VoiceOptions } from './voice.js';

export type AppOptions = {
  dataDir?: string; now?: () => number; origin?: string;
  env?: Record<string, string | undefined>;
  tutor?: GenerateReply;
  speech?: typeof synthesizeSpeech;
  rateLimit?: boolean;
  voice?: VoiceOptions;
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
  const voice = new VoiceManager({ store, env, now: clock, tutor: options.tutor ?? generateTutorReply, voice: options.voice, origin: options.origin ?? env.APP_ORIGIN ?? 'http://localhost:3000' });
  const authenticate = (header: string | undefined) => store.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  const now = () => new Date(clock()).toISOString();
  const bump = (session: Session) => { session.revision++; session.updatedAt = now(); return session; };
  const ensureActive = (session: Session) => { if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'This lesson has ended. Start a new lesson to keep learning.'); };
  const parse = <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'The request contains invalid or missing fields.');
    return result.data;
  };
  async function live(session: Session, text: string, selectedNodeId?: string) {
    if (!providers().tutor) throw new ApiError(503, 'TUTOR_UNAVAILABLE', 'Live AI is not configured. Choose a sample lesson or configure Gemini on the server.');
    return (options.tutor ?? generateTutorReply)({ session, text, selectedNodeId, apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL! });
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError || error instanceof TutorError) return reply.status(error.status).send({ code: error.code, message: error.message, requestId: request.id });
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
        const result = await live(session, 'Introduce this lesson with a short explanation and one diagnostic question.');
        session.messages[0]!.text = result.text;
        if (result.board) session.board = result.board;
      }
      await store.save(principal, session);
      return reply.status(201).send({ session });
    });
  });
  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async request => ({ session: await store.get(await authenticate(request.headers.authorization), request.params.id) }));
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/messages', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async request => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(SendMessageSchema, request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      voice.assertHttpAvailable(session.id);
      if (session.messages.length >= 201) throw new ApiError(429, 'TURN_LIMIT', 'This lesson has reached its message limit. Finish it and start a new lesson.');
      if (input.selectedNodeId && !session.board.nodes.some(node => node.id === input.selectedNodeId)) throw new ApiError(400, 'INVALID_SELECTION', 'The selected board item is no longer available. Select it again.');
      const result = session.mode === 'sample' ? { text: sampleReply(session, input.text, input.selectedNodeId) } : await live(session, input.text, input.selectedNodeId);
      session.messages.push({ id: randomUUID(), role: 'student', text: input.text, createdAt: now() }, { id: randomUUID(), role: 'tutor', text: result.text, createdAt: now() });
      if ('board' in result && result.board) session.board = result.board;
      await store.save(principal, bump(session)); return { session };
    });
  });
  app.patch<{ Params: { id: string } }>('/v1/sessions/:id/board', async request => {
    const principal = await authenticate(request.headers.authorization);
    const input = parse(UpdateBoardSchema, request.body);
    return store.locked(request.params.id, async () => {
      const session = await store.get(principal, request.params.id); ensureActive(session);
      if (session.revision !== input.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'The lesson changed. Reload its latest board and try again.');
      session.board = input.board;
      await store.save(principal, bump(session)); return { session };
    });
  });
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/end', async request => {
    const principal = await authenticate(request.headers.authorization);
    await store.get(principal, request.params.id);
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
