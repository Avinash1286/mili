import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CourseProgressSchema, CourseScriptSchema, SaveCourseProgressSchema,
  StartCourseSessionSchema, PrepareChapterRequestSchema,
  CourseTurnRequestSchema, CourseHelpRequestSchema, CourseSpeechRequestSchema,
  emptyCourseProgress, splitStepTeaching, stripSpeechFormatting, TOPICS,
  type CourseProgress, type CourseScript, type CourseStep, type Session, type Source,
} from '@milli/contracts';
import { StoreError, type Principal } from '@milli/db';
import { getLessonPack } from '@milli/learning';
import { synthesizeSpeech } from '@milli/speech';
import {
  createLesson,
  generateInitialCourse,
  generateNextCourseChapter,
  runAgenticCourseTurn,
  deterministicAgenticTurn,
  generateCourseHelp,
  deterministicCourseHelp,
  getAuthoredCourseScript,
} from '@milli/tutor-core';
import { liveModels, liveModelsConfigured } from './live-models.js';
import { requestSignal } from './request-lifecycle.js';
import { retrieveSources } from './source-routes.js';
import {
  principal, parse, preferences, optionalResource, metered,
  bumpSession, initializeLearning, enqueueArtifact, type ProductContext,
} from './product-context.js';

type CourseState = { script: CourseScript; progress: CourseProgress; revision: number };

const inFlightInitByStore = new WeakMap<ProductContext['store'], Map<string, Promise<CourseState>>>();
const inFlightBgByStore = new WeakMap<ProductContext['store'], Map<string, { abort: AbortController; done: Promise<unknown> }>>();

function getInitMap(store: ProductContext['store']) {
  let map = inFlightInitByStore.get(store);
  if (!map) {
    map = new Map();
    inFlightInitByStore.set(store, map);
  }
  return map;
}

function getBgMap(store: ProductContext['store']) {
  let map = inFlightBgByStore.get(store);
  if (!map) {
    map = new Map();
    inFlightBgByStore.set(store, map);
  }
  return map;
}

function sourceRefsFromSession(session: Session) {
  return session.citations?.map(c => ({
    sourceId: c.sourceId,
    sourceVersion: String(c.sourceVersion),
    title: c.title,
    snippet: c.snippet,
  }));
}

export async function ensureCourseScript(context: ProductContext, p: Principal, session: Session, _signal?: AbortSignal): Promise<CourseState> {
  const initMap = getInitMap(context.store);
  const running = initMap.get(session.id);
  if (running) return running;

  const task = ensureCourseScriptImpl(context, p, session).finally(() => {
    if (initMap.get(session.id) === task) initMap.delete(session.id);
  });
  initMap.set(session.id, task);
  return task;
}

async function ensureCourseScriptImpl(context: ProductContext, p: Principal, session: Session): Promise<CourseState> {
  const { store, env, now } = context;
  const existingScript = await optionalResource<CourseScript>(store, p, 'course-script', session.id);
  const existingProg = await optionalResource<CourseProgress>(store, p, 'course-progress', session.id);
  let script = existingScript?.data;

  if (!script) {
    if (session.mode === 'sample' || !liveModelsConfigured(env)) {
      const sample = getAuthoredCourseScript(session.topic);
      if (sample && session.settings?.grounding !== 'sources-only') {
        script = sample;
      } else {
        script = await generateInitialCourse({
          topic: session.topic,
          mode: 'sample',
          settings: session.settings,
          apiKey: '',
          model: '',
        });
      }
    } else {
      const initialFn = context.providers?.courseInitial ?? generateInitialCourse;
      script = await metered(
        context, p, 'model', 1,
        onUsage => initialFn({
          topic: session.topic,
          mode: 'live',
          settings: session.settings,
          sourceRefs: sourceRefsFromSession(session),
          ...liveModels(env),
          signal: AbortSignal.timeout(38000),
          onUsage,
        }),
        { sessionId: session.id, traceId: `course-init:${session.id}` },
      );
    }

    const parsedScript = CourseScriptSchema.parse(script);
    await store.resources.put(p, 'course-script', session.id, parsedScript, {
      expectedRevision: existingScript?.revision ?? -1,
      sessionId: session.id,
    }).catch(async () => {
      const latest = await optionalResource<CourseScript>(store, p, 'course-script', session.id);
      if (latest) script = latest.data;
    });

    // Sync planned syllabus metadata onto session so saved lessons display clean titles & objectives
    if (!session.plan && script) {
      await store.locked(session.id, async () => {
        const latest = await store.get(p, session.id).catch(() => undefined);
        if (!latest || latest.plan) return;
        latest.title = script!.title || latest.title;
        latest.plan = {
          version: 1,
          goal: session.settings?.goal || script!.summary,
          level: session.settings?.preferences.level ?? 'intermediate',
          minutes: session.settings?.preferences.lessonMinutes ?? 15,
          objectives: script!.chapters.map(c => c.goal).slice(0, 8),
          prerequisites: [],
          steps: script!.chapters.map(c => ({ title: c.title.slice(0, 120), objective: c.goal })),
          provenance: script!.provenance,
          status: 'ready',
        };
        await store.save(p, bumpSession(latest, now()));
      }).catch(() => {});
    }
  }

  let progress = existingProg?.data;
  let revision = existingProg?.revision ?? 0;
  if (!progress) {
    progress = emptyCourseProgress();
    const saved = await store.resources.put(p, 'course-progress', session.id, progress, {
      expectedRevision: -1,
      sessionId: session.id,
    }).catch(async () => optionalResource<CourseProgress>(store, p, 'course-progress', session.id));
    if (saved) {
      progress = saved.data;
      revision = saved.revision;
    }
  }

  return {
    script: CourseScriptSchema.parse(script),
    progress: CourseProgressSchema.parse(progress),
    revision,
  };
}

export async function registerCourse(app: FastifyInstance, context: ProductContext) {
  const { store, env, now } = context;

  // Fast launcher: creates the owned lesson session immediately so the player opens without upfront multi-call delay.
  app.post('/v1/courses/start', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = await principal(request, store);
    const input = parse(StartCourseSessionSchema, request.body);
    const pack = getLessonPack(input.topic);
    const authored = getAuthoredCourseScript(input.topic);
    const featured = input.featured && TOPICS.some(topic => topic.id === input.topic) ? authored : undefined;
    if (input.featured && (!featured || input.sourceIds.length || input.grounding !== 'general')) {
      throw new StoreError(400, 'FEATURED_TOPIC', 'Featured lessons use their prepared material. Choose a custom lesson to teach from uploads.');
    }

    if (input.mode === 'sample' && !pack && !authored) {
      throw new StoreError(400, 'SAMPLE_TOPIC', 'Prepared samples are available for the four library topics. Choose Live AI for a custom topic.');
    }
    if (input.grounding === 'sources-only' && !input.sourceIds.length) {
      throw new StoreError(400, 'SOURCES_REQUIRED', 'Select a ready source for source-only teaching.');
    }
    if (input.mode === 'sample' && input.sourceIds.length) {
      throw new StoreError(400, 'SAMPLE_GROUNDING', 'Prepared samples use their authored references. Choose Live AI to teach from uploads.');
    }
    if (input.mode === 'live' && !liveModelsConfigured(env)) {
      throw new StoreError(503, 'TUTOR_UNAVAILABLE', 'Configure a live model to start a Live AI lesson. Prepared samples remain available.');
    }

    const sources = await Promise.all(input.sourceIds.map(id => store.resources.get<Source>(p, 'source', id)));
    if (sources.some(source => source.data.status !== 'ready')) {
      throw new StoreError(409, 'SOURCES_NOT_READY', 'Wait for every selected source to finish processing.');
    }

    const savedPrefs = input.preferences ?? (await preferences(store, p)).preferences;
    const settings = {
      preferences: input.mode === 'sample' ? { ...savedPrefs, language: 'english' as const } : savedPrefs,
      goal: input.goal || input.topic,
      sourceIds: [...new Set(input.sourceIds)],
      grounding: input.grounding,
    };

    const session = createLesson({ ...input, id: randomUUID(), now: now(), messageId: randomUUID() });
    session.settings = settings;
    if (featured) session.title = featured.title;
    if (session.mode === 'live' || settings.grounding === 'sources-only') {
      session.messages = [];
      session.board = { revision: 0, nodes: [], edges: [], frames: [] };
      session.concepts = [];
      session.flashcards = [];
      session.conceptMap = { topicId: session.topic, revision: 0, nodes: [], edges: [] };
    }

    if (settings.sourceIds.length) {
      session.citations = await retrieveSources(
        context, p, session,
        `${input.topic} ${settings.goal}`,
        AbortSignal.any([requestSignal(request), AbortSignal.timeout(15000)]),
      );
    }

    if (featured || (pack && input.mode === 'sample')) {
      const objectives = featured ? featured.chapters.map(chapter => chapter.goal) : pack!.objectives.slice(0, 8).map(item => item.text);
      session.plan = {
        version: 1,
        goal: settings.goal,
        level: settings.preferences.level,
        minutes: settings.preferences.lessonMinutes,
        objectives,
        prerequisites: pack?.prerequisites.slice(0, 8) ?? [],
        steps: featured ? featured.chapters.map(({ title, goal }) => ({ title, objective: goal }))
          : objectives.map(objective => ({ title: objective.slice(0, 120), objective })),
        provenance: 'authored',
        status: 'ready',
      };
    }

    await store.locked(`owner:${p.ownerId}`, async () => {
      if ((await store.list(p)).length >= 100) {
        throw new StoreError(429, 'SESSION_LIMIT', 'Delete unused lessons before creating more than 100.');
      }
      for (const source of sources) await store.resources.get(p, 'source', source.id);
      await store.create(p, session);
      if (featured) await store.resources.put(p, 'course-script', session.id, featured, { expectedRevision: -1, sessionId: session.id });
      await initializeLearning(context, p, session);
      await store.appendEvent(p, session.id, { id: randomUUID(), type: 'lesson.created' });
    });

    return reply.status(201).send({ session });
  });

  app.get<{ Params: { id: string } }>('/v1/sessions/:id/course', async request => {
    const p = await principal(request, store);
    const session = await store.get(p, request.params.id);
    const state = await ensureCourseScript(context, p, session, requestSignal(request));
    return { script: state.script, progress: state.progress, revision: state.revision };
  });

  // Progressive background generator for pending syllabus chapters while the learner studies Chapter 1.
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/course-prepare', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const p = await principal(request, store);
    const input = parse(PrepareChapterRequestSchema, request.body ?? {});
    const session = await store.get(p, request.params.id);
    const state = await ensureCourseScript(context, p, session, requestSignal(request));

    const targetIdx = input.chapterIndex !== undefined
      ? input.chapterIndex
      : state.script.chapters.findIndex(ch => ch.status === 'pending' || ch.steps.length === 0);

    if (targetIdx < 0 || targetIdx >= state.script.chapters.length) {
      return { script: state.script, preparedChapter: -1 };
    }
    const targetChapter = state.script.chapters[targetIdx]!;
    if (targetChapter.status === 'ready' && targetChapter.steps.length > 0) {
      return { script: state.script, preparedChapter: targetIdx };
    }

    let generatedSteps: CourseStep[];
    if (session.mode === 'sample' || !liveModelsConfigured(env)) {
      generatedSteps = await generateNextCourseChapter({
        script: state.script,
        chapterIndex: targetIdx,
        history: state.progress.history,
        settings: session.settings,
        apiKey: '',
        model: '',
      });
    } else {
      const bgMap = getBgMap(store);
      const existingBg = bgMap.get(p.ownerId);
      if (existingBg) {
        await existingBg.done.catch(() => undefined);
      }
      const bgAbort = new AbortController();
      const chapterFn = context.providers?.courseChapter ?? generateNextCourseChapter;
      const bgTask = metered(
        context, p, 'model', 1,
        onUsage => chapterFn({
          script: state.script,
          chapterIndex: targetIdx,
          history: state.progress.history,
          settings: session.settings,
          sourceRefs: sourceRefsFromSession(session),
          ...liveModels(env),
          signal: AbortSignal.any([requestSignal(request), bgAbort.signal, AbortSignal.timeout(38000)]),
          onUsage,
        }),
        { sessionId: session.id, traceId: `course-prepare:${session.id}:${targetIdx}` },
      );
      const entry = { abort: bgAbort, done: bgTask };
      bgMap.set(p.ownerId, entry);
      try {
        generatedSteps = await bgTask;
      } finally {
        if (bgMap.get(p.ownerId) === entry) bgMap.delete(p.ownerId);
      }
    }

    const updatedScript = await store.locked(`course-script:${session.id}`, async () => {
      const currentRecord = await optionalResource<CourseScript>(store, p, 'course-script', session.id);
      const base = currentRecord?.data ?? state.script;
      const existingCh = base.chapters[targetIdx];
      if (!existingCh || (existingCh.status === 'ready' && existingCh.steps.length > 0)) {
        return base;
      }
      const otherIds = new Set(
        base.chapters.flatMap((ch, idx) => idx === targetIdx ? [] : ch.steps.map(s => s.id)),
      );
      const safeSteps = generatedSteps.map((s, idx) =>
        otherIds.has(s.id) ? { ...s, id: `ch${targetIdx + 1}-s${idx + 1}-${Date.now().toString(36).slice(-4)}` } : s,
      );
      const next: CourseScript = CourseScriptSchema.parse({
        ...base,
        chapters: base.chapters.map((ch, idx) =>
          idx === targetIdx ? { ...ch, status: 'ready' as const, steps: safeSteps } : ch,
        ),
      });
      await store.resources.put(p, 'course-script', session.id, next, {
        expectedRevision: currentRecord?.revision ?? -1,
        sessionId: session.id,
      });
      return next;
    });

    return { script: updatedScript, preparedChapter: targetIdx };
  });

  // Goal-directed Agentic Turn Loop: adapts to right/wrong answers, answers side-questions & bridges back to track, or inserts remedial steps.
  app.post<{ Params: { id: string } }>('/v1/sessions/:id/course-turn', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const p = await principal(request, store);
    const input = parse(CourseTurnRequestSchema, request.body);
    const session = await store.get(p, request.params.id);
    const state = await ensureCourseScript(context, p, session, requestSignal(request));

    let foundChapterIdx = -1;
    let foundStep: CourseStep | undefined;
    for (let ci = 0; ci < state.script.chapters.length; ci++) {
      const s = state.script.chapters[ci]!.steps.find(item => item.id === input.stepId);
      if (s) {
        foundChapterIdx = ci;
        foundStep = s;
        break;
      }
    }
    if (!foundStep || foundChapterIdx < 0) {
      throw new StoreError(404, 'NOT_FOUND', 'Course step not found.');
    }

    const turnFn = context.providers?.courseTurn ?? runAgenticCourseTurn;
    let reply;
    if (session.mode === 'sample' || !liveModelsConfigured(env)) {
      reply = deterministicAgenticTurn(state.script, foundStep, input);
    } else {
      const bgMap = getBgMap(store);
      const existingBg = bgMap.get(p.ownerId);
      if (existingBg) {
        existingBg.abort.abort();
        await existingBg.done.catch(() => undefined);
      }
      reply = await metered(
        context, p, 'model', 1,
        onUsage => turnFn({
          course: state.script,
          chapterIndex: foundChapterIdx,
          step: foundStep!,
          request: input,
          history: state.progress.history,
          onFallback: reason => request.log.warn({ code: reason.code, fields: reason.fields }, 'Course conversation used prepared fallback'),
          mode: session.mode,
          ...liveModels(env),
          timeoutMs: 27500,
          signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(28000)]),
          onUsage,
        }),
        { sessionId: session.id, traceId: `course-turn:${session.id}:${foundStep.id}` },
      );
    }

    let finalScript = state.script;
    if (reply.insertedStep) {
      const toInsert = reply.insertedStep;
      finalScript = await store.locked(`course-script:${session.id}`, async () => {
        const currentRecord = await optionalResource<CourseScript>(store, p, 'course-script', session.id);
        const base = currentRecord?.data ?? state.script;
        const alreadyHas = base.chapters.some(ch => ch.steps.some(s => s.id === toInsert.id));
        const targetCh = base.chapters[foundChapterIdx];
        if (alreadyHas || !targetCh || targetCh.steps.length >= 12) return base;
        const anchorIdx = targetCh.steps.findIndex(s => s.id === input.stepId);
        if (anchorIdx < 0) return base;
        const nextSteps = [...targetCh.steps];
        nextSteps.splice(anchorIdx + 1, 0, toInsert);
        const next = CourseScriptSchema.parse({
          ...base,
          chapters: base.chapters.map((ch, idx) => idx === foundChapterIdx ? { ...ch, steps: nextSteps } : ch),
        });
        await store.resources.put(p, 'course-script', session.id, next, {
          expectedRevision: currentRecord?.revision ?? -1,
          sessionId: session.id,
        });
        return next;
      });
    }

    return { reply, script: finalScript };
  });

  app.put<{ Params: { id: string } }>('/v1/sessions/:id/course-progress', async request => {
    const p = await principal(request, store), input = parse(SaveCourseProgressSchema, request.body);
    const session = await store.get(p, request.params.id);
    const current = await optionalResource<CourseProgress>(store, p, 'course-progress', session.id);
    const expected = current ? current.revision : -1;
    const saved = await store.resources.put(p, 'course-progress', session.id, input.progress, { expectedRevision: input.revision >= 0 ? input.revision : expected, sessionId: session.id });
    if (input.progress.completedAt && session.status !== 'ended') {
      await store.locked(session.id, async () => {
        const latest = await store.get(p, session.id);
        if (latest.status !== 'ended') {
          latest.status = 'ended';
          await store.save(p, bumpSession(latest, now()));
          await enqueueArtifact(context, p, latest, 'study-pack');
        }
      });
    }
    return { progress: saved.data, revision: saved.revision };
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/course-help', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const p = await principal(request, store), input = parse(CourseHelpRequestSchema, request.body);
    const session = await store.get(p, request.params.id);
    const { script } = await ensureCourseScript(context, p, session, requestSignal(request));
    const step = script.chapters.flatMap(c => c.steps).find(s => s.id === input.stepId);
    if (!step) throw new StoreError(404, 'NOT_FOUND', 'Course step not found.');
    if (session.mode === 'sample' || !liveModelsConfigured(env)) {
      return { reply: deterministicCourseHelp(step, input) };
    }
    const reply = await metered(context, p, 'model', 1, onUsage =>
      generateCourseHelp({
        course: script, step, request: input, mode: session.mode,
        ...liveModels(env),
        signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(25000)]),
        onUsage,
      }),
      { sessionId: session.id, traceId: `course-help:${session.id}:${step.id}` },
    );
    return { reply };
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/course-speech', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = await principal(request, store), input = parse(CourseSpeechRequestSchema, request.body);
    const session = await store.get(p, request.params.id);
    if (!env.ASSEMBLYAI_API_KEY) {
      throw new StoreError(503, 'SPEECH_UNAVAILABLE', 'AssemblyAI speech is unreachable right now. Continue the lesson with chat.');
    }

    let raw = '';
    if (input.text && input.text.trim().length > 0) {
      raw = stripSpeechFormatting(input.text).slice(0, 900);
    } else if (input.stepId) {
      const { script } = await ensureCourseScript(context, p, session, requestSignal(request));
      const step = script.chapters.flatMap(c => c.steps).find(s => s.id === input.stepId);
      if (!step) throw new StoreError(404, 'NOT_FOUND', 'Course step not found.');
      const split = splitStepTeaching(step);
      if (input.part === 'concept') raw = split.conceptSpeech;
      else if (input.part === 'question') raw = split.questionSpeech || split.conceptSpeech;
      else if (input.part === 'step') raw = split.combinedSpeech;
      else if (input.part === 'explanation') raw = stripSpeechFormatting(step.explanation);
      else raw = split.combinedSpeech || stripSpeechFormatting(`${step.title ? `${step.title}. ` : ''}${step.body}`);
      raw = raw.slice(0, 900);
    } else {
      throw new StoreError(400, 'INVALID_REQUEST', 'Provide either text or stepId for speech synthesis.');
    }

    if (!raw.trim()) throw new StoreError(400, 'INVALID_REQUEST', 'Speech text cannot be empty.');
    const speechFn = context.providers?.speech ?? synthesizeSpeech;
    try {
      const result = await metered(context, p, 'speech', [...raw].length, () =>
        speechFn({
          text: raw,
          apiKey: env.ASSEMBLYAI_API_KEY!,
          voiceId: session.settings?.preferences.voiceId ?? env.ASSEMBLYAI_VOICE_ID,
          language: session.settings?.preferences.language,
          signal: AbortSignal.any([requestSignal(request), AbortSignal.timeout(25000)]),
        }),
        { sessionId: session.id },
      );
      return reply.type(result.contentType).header('Cache-Control', 'no-store').send(result.audio);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(503, 'SPEECH_FAILED', 'AssemblyAI speech is unreachable right now. Continue the lesson with chat.');
    }
  });
}
