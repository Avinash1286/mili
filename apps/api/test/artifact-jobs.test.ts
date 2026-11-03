import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileObjectStore, FileStore, type JobRecord, type Principal } from '@tokai/db';
import { LearnerPreferencesSchema, SessionSettingsSchema, type Artifact, type Session, type StudyPack } from '@tokai/contracts';
import { createLesson } from '@tokai/tutor-core';
import { buildStudyPack, getLessonPack } from '@tokai/learning';
import { PDFDocument } from 'pdf-lib';
import { parseSource } from '../../../packages/grounding/src/parse';
import { runArtifact, synthesizeRecap, captionWords } from '../src/artifact-jobs';
import { pcmToWav, renderStudyPackPdf } from '../src/artifact-export';
import type { ProductContext } from '../src/product-context';
import type { ArtifactFile } from '../src/artifact-routes';

describe('durable artifact jobs', () => {
  let directory: string, store: FileStore, objects: FileObjectStore, principal: Principal, session: Session, context: ProductContext, time: number;
  beforeEach(async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'tokai-artifact-')); time = Date.parse('2026-11-03T12:00:00.000Z');
    store = new FileStore(resolve(directory, 'db'), () => time); objects = new FileObjectStore(resolve(directory, 'objects'));
    await store.initialize(); principal = await store.authenticate((await store.createGuest()).token);
    session = createLesson({ id: randomUUID(), topic: 'photosynthesis', mode: 'sample', now: new Date(time).toISOString(), messageId: 'intro' });
    await store.create(principal, session);
    context = { store, objects, env: {}, now: () => new Date(time).toISOString(), closeSession: async () => {}, providers: {} };
  });
  afterEach(async () => {
    await store.close(); objects.close(); const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('tokai-artifact-')) throw new Error('Unexpected test cleanup target.');
    await rm(target, { recursive: true, force: true });
  });
  async function job(kind: Artifact['kind'], format?: Artifact['format']): Promise<JobRecord> {
    const id = randomUUID(), artifact: Artifact = { id, sessionId: session.id, kind, format, status: 'queued', revision: 0, createdAt: context.now(), updatedAt: context.now() };
    await store.resources.put(principal, 'artifact', id, artifact, { expectedRevision: -1, sessionId: session.id });
    await store.outbox.enqueue(principal, { id: randomUUID(), kind: 'artifact', sessionId: session.id, resourceKind: 'artifact', resourceId: id, expectedRevision: 0 });
    return (await store.outbox.claim('test-worker', 1, 120000))[0];
  }
  it('publishes a study pack and downloadable owned Markdown once, with immutable fenced storage', async () => {
    const task = await job('study-pack'); await runArtifact(context, principal, task, new AbortController().signal);
    const artifact = await store.resources.get<Artifact>(principal, 'artifact', task.resourceId!);
    const study = await store.resources.get<StudyPack>(principal, 'study-pack', session.id);
    const file = await store.resources.get<ArtifactFile>(principal, 'artifact-file', artifact.id);
    expect(artifact.data.status).toBe('ready'); expect(study.data.completedNarration).toEqual([]);
    expect(file.data.storageKey).toMatch(new RegExp(`^artifact/${artifact.id}/${task.id}-${task.fence}-[a-f0-9-]+$`));
    expect((await objects.get(file.data.storageKey)).body.toString()).toContain('Reference material');
    await runArtifact(context, principal, task, new AbortController().signal);
    expect((await store.resources.get(principal, 'study-pack', session.id)).revision).toBe(study.revision);
    const stranger = await store.authenticate((await store.createGuest()).token);
    await expect(store.resources.get(stranger, 'artifact-file', artifact.id)).rejects.toMatchObject({ status: 404 });
  });
  it('does not resurrect a deleted session and removes unpublished uploaded bytes', async () => {
    const task = await job('export', 'json'), put = objects.put.bind(objects); let uploadedKey = '';
    vi.spyOn(objects, 'put').mockImplementation(async (...args) => { uploadedKey = args[0]; const result = await put(...args); await store.delete(principal, session.id); return result; });
    await expect(runArtifact(context, principal, task, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    await expect(objects.head(uploadedKey)).rejects.toMatchObject({ code: 'OBJECT_MISSING' });
    await expect(store.get(principal, session.id)).rejects.toMatchObject({ status: 404 });
  });
  it('isolates duplicated deliveries under the same fence so loser cleanup cannot remove published bytes', async () => {
    const task = await job('export', 'json'), put = objects.put.bind(objects), keys: string[] = [];
    let release!: () => void; const uploaded = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(objects, 'put').mockImplementation(async (...args) => { const result = await put(...args); keys.push(args[0]); if (keys.length === 2) release(); await uploaded; return result; });
    const results = await Promise.allSettled([runArtifact(context, principal, task, new AbortController().signal), runArtifact(context, principal, task, new AbortController().signal)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(new Set(keys).size).toBe(2);
    const pointer = (await store.resources.get<ArtifactFile>(principal, 'artifact-file', task.resourceId!)).data;
    expect((await objects.get(pointer.storageKey)).body.length).toBeGreaterThan(100);
    await expect(objects.head(keys.find(key => key !== pointer.storageKey)!)).rejects.toMatchObject({ code: 'OBJECT_MISSING' });
  });
  it('refuses publication when the worker loses its fence after upload', async () => {
    const task = await job('export', 'json'), put = objects.put.bind(objects); let uploadedKey = '';
    vi.spyOn(objects, 'put').mockImplementation(async (...args) => { uploadedKey = args[0]; const result = await put(...args); time += 121000; const replacement = (await store.outbox.claim('replacement', 1, 120000))[0]; expect(replacement.fence).toBe(task.fence + 1); return result; });
    await expect(runArtifact(context, principal, task, new AbortController().signal)).rejects.toMatchObject({ code: 'JOB_LEASE_LOST' });
    await expect(objects.head(uploadedKey)).rejects.toMatchObject({ code: 'OBJECT_MISSING' });
    expect((await store.resources.get<Artifact>(principal, 'artifact', task.resourceId!)).data.status).toBe('queued');
  });
  it('keeps concurrent lesson edits and discards an artifact built against an older snapshot', async () => {
    const task = await job('export', 'markdown'), put = objects.put.bind(objects); let uploadedKey = '';
    vi.spyOn(objects, 'put').mockImplementation(async (...args) => { uploadedKey = args[0]; const result = await put(...args); await store.save(principal, { ...session, revision: 1, notes: 'New student note.' }); return result; });
    await expect(runArtifact(context, principal, task, new AbortController().signal)).rejects.toMatchObject({ code: 'ARTIFACT_CONTEXT_CHANGED' });
    expect((await store.get(principal, session.id)).notes).toBe('New student note.');
    await expect(objects.head(uploadedKey)).rejects.toMatchObject({ code: 'OBJECT_MISSING' });
  });
  it('reuses the prepared sample card set without duplicate identities or pretending to call AI', async () => {
    const provider = vi.fn(); context.providers!.cards = provider;
    const first = await job('cards'); await runArtifact(context, principal, first, new AbortController().signal); await store.outbox.complete(first.id, first.workerId!, first.fence);
    const before = await store.resources.list(principal, 'card', { sessionId: session.id }); expect(before).toHaveLength(8);
    const second = await job('cards'); await runArtifact(context, principal, second, new AbortController().signal);
    const after = await store.resources.list(principal, 'card', { sessionId: session.id }); expect(after.map(item => item.id).sort()).toEqual(before.map(item => item.id).sort());
    expect(provider).not.toHaveBeenCalled();
  });
  it('publishes a generated custom question without a fake seed pack or invented mastery', async () => {
    session = { ...session, topic: 'Reflected sound', title: 'Sound', mode: 'live', revision: 1 }; await store.save(principal, session);
    context.providers!.assessment = vi.fn(async input => ({ ...getLessonPack('photosynthesis')!.assessments[0], id: input.id, version: 'generated-v1', packId: `session:${session.id}`, sourceRefs: [] }));
    const task = await job('assessment'); await runArtifact(context, principal, task, new AbortController().signal);
    expect(await store.resources.list(principal, 'assessment', { sessionId: session.id })).toHaveLength(1);
    expect(await store.resources.list(principal, 'attempt', { sessionId: session.id })).toEqual([]);
    expect((await store.resources.get<Artifact>(principal, 'artifact', task.resourceId!)).data.status).toBe('ready');
  });
  it('honors transcript retention only after durable finalization, preserving a reference pack and attempts', async () => {
    session = { ...session, revision: 1, status: 'ended', settings: SessionSettingsSchema.parse({ preferences: LearnerPreferencesSchema.parse({ retainTranscript: false }), goal: '', sourceIds: [], grounding: 'general' }), messages: [{ id: 'private', role: 'student', text: 'Private conversation phrase.', createdAt: context.now() }], teachingBeats: [{ beatId: 'private-beat', turnId: 'turn', messageId: 'tutor', outputEpoch: 1, status: 'completed', expectedBoardRevision: 0, spokenText: 'Private spoken phrase.', displayText: 'Private spoken phrase.', conceptIds: ['co2'], boardCommands: [], highlightNodeIds: [], sourceRefs: [], playedMs: 300 }] };
    await store.save(principal, session); const task = await job('study-pack'); await runArtifact(context, principal, task, new AbortController().signal);
    const saved = await store.get(principal, session.id), study = (await store.resources.get<StudyPack>(principal, 'study-pack', session.id)).data;
    expect(saved.messages).toEqual([]); expect(saved.teachingBeats).toEqual([]); expect(saved.revision).toBe(2);
    expect(study.sessionRevision).toBe(2); expect(study.completedNarration).toEqual([]); expect(study.partialNarration).toEqual([]);
    expect(study.recap.text).toContain('reference material'); expect(JSON.stringify(study)).not.toContain('Private spoken phrase');
  });
  it('requires explicit retained-audio permission before calling synthesis', async () => {
    const recap = vi.fn(); context.providers!.recap = recap; context.env.ASSEMBLYAI_API_KEY = 'fake-key';
    await expect(synthesizeRecap(context, session, 'A recap.', new AbortController().signal)).rejects.toMatchObject({ code: 'AUDIO_CONSENT_REQUIRED' });
    expect(recap).not.toHaveBeenCalled();
  });
  it('saves real-format PCM/WAV with normalized provider word captions and closes the synthesizer', async () => {
    session = { ...session, revision: 1, settings: SessionSettingsSchema.parse({ preferences: LearnerPreferencesSchema.parse({ retainRecapAudio: true, language: 'spanish' }), goal: '', sourceIds: [], grounding: 'general' }) }; await store.save(principal, session);
    context.env.ASSEMBLYAI_API_KEY = 'offline-key'; const close = vi.fn();
    context.providers!.recap = vi.fn(async input => ({ async speak() { input.onAudio(new Uint8Array(4800), { providerSessionId: 'provider-session', flushId: 0 }); input.onBoundaries?.({ providerSessionId: 'provider-session', flushId: 0, audioStartMs: 500, words: [{ word: 'Hola', startMs: 500, endMs: 600, confidence: .9 }] }); }, cancel: async () => {}, close }));
    const task = await job('recap'); await runArtifact(context, principal, task, new AbortController().signal);
    const artifact = (await store.resources.get<Artifact>(principal, 'artifact', task.resourceId!)).data;
    expect(artifact).toMatchObject({ status: 'ready', format: 'wav', durationMs: 100, captions: [{ text: 'Hola', startMs: 0, endMs: 100 }] });
    expect(vi.mocked(context.providers!.recap).mock.calls[0][0].language).toBe('spanish'); expect(close).toHaveBeenCalledOnce();
    const pointer = await store.resources.get<ArtifactFile>(principal, 'artifact-file', artifact.id), audio = (await objects.get(pointer.data.storageKey)).body;
    expect(audio.toString('ascii', 0, 4)).toBe('RIFF'); expect(audio.readUInt32LE(24)).toBe(24000); expect(audio.readUInt32LE(40)).toBe(4800);
    expect((await store.resources.get<StudyPack>(principal, 'study-pack', session.id)).data.recap.status).toBe('ready');
  });
  it('rejects missing or unordered timing data and malformed PCM rather than fabricating captions', () => {
    const identity = { providerSessionId: 'provider', flushId: 0, audioStartMs: 0 };
    expect(() => captionWords({ ...identity, words: [] }, 100)).toThrow(/timing data/);
    expect(() => captionWords({ ...identity, words: [{ word: 'second', startMs: 20, endMs: 40, confidence: 1 }, { word: 'first', startMs: 0, endMs: 10, confidence: 1 }] }, 100)).toThrow(/validated/);
    expect(() => captionWords({ ...identity, words: [{ word: 'late', startMs: 0, endMs: 5000, confidence: 1 }] }, 100)).toThrow(/validated/);
    expect(() => pcmToWav(new Uint8Array(3))).toThrow(/valid bounded/);
  });
  it('exports a real Unicode PDF whose extracted text retains Greek, subscripts and accents', async () => {
    const study = buildStudyPack({ session, pack: getLessonPack('photosynthesis'), attempts: [], evidence: [], cards: [], notes: 'CO₂ + H₂O; Ω and α; energía; crème brûlée; √9 = 3 → correct.', now: context.now(), id: 'unicode-study' });
    const bytes = await renderStudyPackPdf(study), document = await PDFDocument.load(bytes);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(document.getPageCount()).toBeGreaterThan(1);
    const pages = await parseSource(bytes, 'application/pdf'), text = pages.map(page => page.text).join(' ');
    expect(text).toContain('CO₂ + H₂O'); expect(text).toContain('Ω and α'); expect(text).toContain('crème brûlée'); expect(text).toMatch(/√\s*9 = 3/); expect(text).toMatch(/→\s+correct/);
    await expect(renderStudyPackPdf({ ...study, notes: '漢字' })).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED_GLYPH' });
  }, 20000);
});
