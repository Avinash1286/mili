import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { TeachingBeatProposalSchema, type Session } from '@tokai/contracts';
import type { TutorInput, TutorReply } from '@tokai/tutor-core';
import { createApp } from '../src/app.js';

describe('durable teaching and board operations', () => {
  let app: FastifyInstance, directory: string, token: string;
  let tutor: (input: TutorInput) => Promise<TutorReply>;
  const vision = vi.fn(async () => ({ text: 'The shared crop contains a small mark. Tell me what it represents.' }));
  const headers = () => ({ authorization: `Bearer ${token}` });
  const node = { id: 'my-note', label: 'My note', detail: 'Student annotation', kind: 'detail' as const, x: 100, y: 600 };
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'tokai-teaching-'));
    tutor = async () => ({ text: 'Sunlight supplies energy. What supplies carbon?' }); vision.mockClear();
    app = await createApp({ dataDir: directory, rateLimit: false, env: { GEMINI_API_KEY: 'fake', GEMINI_MODEL: 'fake' }, tutor: input => tutor(input), vision });
    token = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
  });
  afterEach(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function create(mode: 'sample' | 'live' = 'sample'): Promise<Session> { return (await app.inject({ method: 'POST', url: '/v1/sessions', headers: headers(), payload: { topic: 'photosynthesis', mode } })).json().session; }
  async function get(id: string): Promise<Session> { return (await app.inject({ url: `/v1/sessions/${id}`, headers: headers() })).json().session; }
  it('deduplicates persisted board edits independently of transcript revisions and rejects changed operation IDs', async () => {
    const session = await create(), transaction = { operationId: 'edit-1', expectedRevision: 0, commands: [{ type: 'upsert_node', node: { ...node, author: 'tutor' } }] };
    const edit = () => app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/board-operations`, headers: headers(), payload: transaction });
    expect((await edit()).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Hello' } });
    const before = await get(session.id); expect(before.revision).toBeGreaterThan(before.board.revision!);
    expect((await edit()).statusCode).toBe(200);
    const after = await get(session.id); expect(after.revision).toBe(before.revision); expect(after.board.revision).toBe(1);
    expect(after.board.nodes.find(value => value.id === node.id)?.author).toBe('student');
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/board-operations`, headers: headers(), payload: { ...transaction, commands: [{ type: 'upsert_node', node: { ...node, label: 'Changed' } }] } })).statusCode).toBe(409);
  });
  it('applies authored sample teaching visuals through the same durable beat validator', async () => {
    const session = await create();
    const result = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Show me a diagram' } });
    expect(result.statusCode).toBe(200);
    const saved = result.json().session as Session;
    expect(saved.board.frames?.some(frame => frame.title.startsWith('Prepared sample'))).toBe(true);
    expect(saved.teachingBeats?.[0]?.status).toBe('ready');
    expect(saved.teachingBeats?.[0]?.warnings ?? []).toEqual([]);
    expect(saved.conceptMap?.nodes.length).toBeGreaterThan(0);
    expect(saved.messages.at(-1)?.delivery).toBeUndefined();
  });
  it('persists a prepared sample model and answers selected parts from the trusted catalog', async () => {
    const session = await create();
    const shown = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Show a 3D model' } });
    expect(shown.statusCode).toBe(200);
    expect(shown.json().session.spatialState).toEqual({ modelId: 'chloroplast', assetVersion: '1.0.0', partIds: [] });
    const spatial = { modelId: 'chloroplast', assetVersion: '1.0.0', partIds: ['thylakoid'] };
    const selected = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Explain this part', selection: { shapeIds: [], conceptIds: [], boardRevision: 0, spatial } } });
    expect(selected.statusCode).toBe(200);
    const saved = await get(session.id);
    expect(saved.spatialState).toEqual(spatial);
    expect(saved.visualSurface).toBe('spatial');
    expect(saved.messages.at(-1)?.text).toContain('Prepared sample model');
    expect(saved.messages.at(-1)?.text).toContain('Thylakoid');
    expect(saved.teachingBeats?.at(-1)?.warnings ?? []).toEqual([]);
  });
  it('switches a sample lesson from its model to a requested diagram while preserving the saved model', async () => {
    const session = await create();
    const spatial = { modelId: 'chloroplast', assetVersion: '1.0.0', partIds: ['thylakoid'] };
    await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Explain this part', selection: { shapeIds: [], conceptIds: [], boardRevision: 0, spatial } } });
    const plain = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Hello' } });
    expect(plain.json().session.visualSurface).toBe('spatial');
    const result = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Show a diagram on the board', selection: { shapeIds: [], conceptIds: [], boardRevision: 0, spatial } } });
    expect(result.statusCode).toBe(200);
    const saved = await get(session.id);
    expect(saved.visualSurface).toBe('board');
    expect(saved.spatialState).toEqual(spatial);
    expect(saved.teachingBeats?.at(-1)?.spatialUpdate).toBeUndefined();
    expect(saved.board.frames?.length).toBeGreaterThan(0);
    const continued = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Hello' } });
    expect(continued.json().session.visualSurface).toBe('board');
  });
  it('rejects invalid spatial selections before provider work or history changes', async () => {
    const session = await create('live');
    const called = vi.fn(async () => ({ text: 'This must not run.' })); tutor = called;
    for (const spatial of [{ modelId: 'chloroplast', assetVersion: '1.0.0', partIds: ['aorta'] }, { modelId: 'chloroplast', assetVersion: 'outdated', partIds: [] }, { modelId: 'unapproved', assetVersion: '1.0.0', partIds: [] }]) {
      const response = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Explain this part', selection: { shapeIds: [], conceptIds: [], boardRevision: 0, spatial } } });
      expect(response.statusCode).toBe(400);
    }
    expect(called).not.toHaveBeenCalled();
    expect((await get(session.id)).messages).toEqual(session.messages);
  });
  it('preserves a concurrent student edit when a model visual plan was based on an old board revision', async () => {
    const session = await create('live'); let resolve!: (value: TutorReply) => void;
    tutor = async () => new Promise(done => { resolve = done; });
    const pending = app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/messages`, headers: headers(), payload: { text: 'Draw while I edit' } });
    const response = Promise.resolve(pending);
    for (let i = 0; i < 100 && !resolve; i++) await new Promise(done => setTimeout(done, 5));
    expect(resolve).toBeDefined();
    await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/board-operations`, headers: headers(), payload: { operationId: 'concurrent', expectedRevision: 0, commands: [{ type: 'upsert_node', node }] } });
    resolve({ text: 'An energy diagram.', beats: [TeachingBeatProposalSchema.parse({ spokenText: 'Light supplies energy.', displayText: 'Light supplies energy.', boardCommands: [{ type: 'upsert_node', node: { ...node, id: 'late-model-shape' } }] })] });
    expect((await response).statusCode).toBe(200);
    const saved = await get(session.id);
    expect(saved.board.nodes.some(value => value.id === node.id)).toBe(true);
    expect(saved.board.nodes.some(value => value.id === 'late-model-shape')).toBe(false);
    expect(saved.teachingBeats?.at(-1)?.warnings?.join(' ')).toContain('board changed');
  });
  it('protects untagged historical work and prevents links to invented lesson artifacts', async () => {
    const session = await create(), file = path.join(directory, 'sessions', `${session.id}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    for (const value of [...record.session.board.nodes, ...record.session.board.edges]) delete value.author;
    await writeFile(file, JSON.stringify(record));
    expect((await get(session.id)).board.nodes.every(value => value.author === 'student')).toBe(true);
    const result = await app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/map`, headers: headers(), payload: { expectedRevision: 0, topicId: 'photosynthesis', mode: 'merge', nodes: [{ id: 'x', label: 'Invented reference', status: 'introduced', boardNodeIds: ['other-session-shape'] }], edges: [] } });
    expect(result.statusCode).toBe(400); expect(result.json().code).toBe('INVALID_MAP_REFERENCE');
  });
  it('loads, lists and edits legacy opaque IDs without remapping saved references', async () => {
    const session = await create(), file = path.join(directory, 'sessions', `${session.id}.json`);
    const record = JSON.parse(await readFile(file, 'utf8'));
    const firstId = 'my legacy note', secondId = 'ऊर्जा "light"';
    record.session.board = {
      nodes: [{ ...node, id: firstId }, { ...node, id: secondId, x: 400 }],
      edges: [{ id: 'legacy connection →', from: firstId, to: secondId, label: 'relates to' }]
    };
    delete record.session.conceptMap; delete record.session.lessonFocus; delete record.session.teachingBeats;
    await writeFile(file, JSON.stringify(record));
    const loaded = await get(session.id);
    expect(loaded.board.nodes.map(value => value.id)).toEqual([firstId, secondId]);
    expect(loaded.board.nodes.every(value => value.author === 'student')).toBe(true);
    const listed = (await app.inject({ url: '/v1/sessions', headers: headers() })).json().sessions as Session[];
    expect(listed.find(value => value.id === session.id)?.board).toEqual(loaded.board);
    const result = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/board-operations`, headers: headers(), payload: { operationId: 'edit-legacy', expectedRevision: 0, commands: [{ type: 'upsert_node', node: { ...loaded.board.nodes[0]!, label: 'Edited legacy note' } }] } });
    expect(result.statusCode).toBe(200);
    const saved = await get(session.id);
    expect(saved.board.nodes[0]).toMatchObject({ id: firstId, label: 'Edited legacy note', author: 'student' });
    expect(saved.board.edges[0]).toMatchObject({ id: 'legacy connection →', from: firstId, to: secondId });
    const other = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
    expect((await app.inject({ url: `/v1/sessions/${session.id}`, headers: { authorization: `Bearer ${other}` } })).statusCode).toBe(404);
  });
  it('applies legacy frame additions, updates and removals in dependency order', async () => {
    let session = await create();
    const save = async (board: Session['board']) => {
      const result = await app.inject({ method: 'PATCH', url: `/v1/sessions/${session.id}/board`, headers: headers(), payload: { revision: session.revision, board } });
      expect(result.statusCode).toBe(200); session = result.json().session;
    };
    const frame = { id: 'legacy-frame', title: 'My frame', x: 0, y: 0, width: 500, height: 400 };
    await save({ ...session.board, frames: [frame], nodes: session.board.nodes.map((value, index) => index === 0 ? { ...value, frameId: frame.id } : value) });
    expect(session.board.frames?.[0]).toMatchObject({ ...frame, author: 'student' });
    expect(session.board.nodes[0]?.frameId).toBe(frame.id);
    await save({ ...session.board, frames: [{ ...session.board.frames![0]!, title: 'Renamed frame' }] });
    expect(session.board.frames?.[0]?.title).toBe('Renamed frame');
    await save({ ...session.board, frames: [], nodes: session.board.nodes.map(value => { const { frameId: _frameId, ...rest } = value; return rest; }) });
    expect(session.board.frames).toEqual([]);
    expect(session.board.nodes.every(value => !value.frameId)).toBe(true);
    expect((await get(session.id)).board).toEqual(session.board);
  });
  it('prunes deleted board associations atomically while retaining the concept and its study history', async () => {
    const session = await create();
    const before = session.conceptMap!.nodes.find(value => value.id === 'co2')!;
    const result = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/board-operations`, headers: headers(), payload: { operationId: 'erase-co2', expectedRevision: 0, commands: [{ type: 'remove_node', id: 'co2' }] } });
    expect(result.statusCode).toBe(200);
    const saved = result.json().session as Session, concept = saved.conceptMap!.nodes.find(value => value.id === 'co2')!;
    expect(saved.board.nodes.some(value => value.id === 'co2')).toBe(false);
    expect(concept.boardNodeIds).toEqual([]); expect(concept.cardIds).toEqual(before.cardIds);
    expect(saved.conceptMap!.revision).toBe(1);
  });
  it('validates explicit shared crops, isolates ownership, and never persists image bytes', async () => {
    const session = await create('live');
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=';
    const payload = { text: 'Explain this crop', image: { mimeType: 'image/png', data } };
    const other = (await app.inject({ method: 'POST', url: '/v1/guest-sessions' })).json().token;
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/explain-image`, headers: { authorization: `Bearer ${other}` }, payload })).statusCode).toBe(404);
    expect(vision).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/explain-image`, headers: headers(), payload: { ...payload, image: { mimeType: 'image/png', data: 'A'.repeat(60) } } })).statusCode).toBe(400);
    const result = await app.inject({ method: 'POST', url: `/v1/sessions/${session.id}/explain-image`, headers: headers(), payload });
    expect(result.statusCode).toBe(200); expect(vision).toHaveBeenCalledOnce();
    expect(await readFile(path.join(directory, 'sessions', `${session.id}.json`), 'utf8')).not.toContain(data);
    expect(result.json().session.messages.at(-2).text).toContain('Shared a board crop');
  });
});
