import { beforeEach, describe, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; }, FunctionCallingConfigMode: { VALIDATED: 'VALIDATED' } }));
import { createLesson, generateTutorReply } from '../src/index.js';

const input = () => ({
  session: createLesson({ id: 'lesson', topic: 'photosynthesis', mode: 'live', now: '2026-11-03T12:00:00.000Z', messageId: 'intro' }),
  text: 'Explain the energy source', apiKey: 'mock-key', model: 'mock-model'
});
describe('live tutor provider boundary', () => {
  beforeEach(() => { generateContent.mockReset(); });
  it('excludes unheard generated text from context and retains confirmed delivered explanations', async () => {
    const request = input();
    request.session.messages.push(
      { id: 'partial', role: 'tutor', text: 'Unheard explanation must not become knowledge', delivery: 'interrupted', playedMs: 350, createdAt: request.session.createdAt },
      { id: 'heard', role: 'tutor', text: 'A confirmed delivered explanation', delivery: 'completed', playedMs: 1000, createdAt: request.session.createdAt }
    );
    generateContent.mockResolvedValue({ text: JSON.stringify({ text: 'Sunlight supplies energy. What brings carbon into the leaf?' }) });
    await expect(generateTutorReply(request)).resolves.toMatchObject({ text: expect.stringContaining('Sunlight') });
    const context = JSON.parse(generateContent.mock.calls[0]![0].contents[0].parts[0].text);
    expect(context.recentConversation[1]).toMatchObject({ delivery: 'interrupted', playedMs: 350 });
    expect(context.recentConversation[1]).not.toHaveProperty('text');
    expect(context.recentConversation[1].note).toContain('Exact heard words are unknown');
    expect(context.recentConversation[2].text).toBe('A confirmed delivered explanation');
  });
  it('rejects oversized and extra untrusted response fields with a visible bounded text recovery', async () => {
    for (const value of [{ text: 'a'.repeat(1201) }, { text: 'A short answer', secretAction: 'execute' }]) {
      generateContent.mockResolvedValue({ text: JSON.stringify(value) });
      const result = await generateTutorReply({ ...input(), limits: { maxModelCalls: 1, maxRepairAttempts: 0 } });
      expect(result.diagnostics?.textOnlyFallback).toBe(true);
      expect(result.beats?.every(beat => !beat.boardCommands.length)).toBe(true);
      expect(result.text).toContain('No visual changes were applied');
      expect(JSON.stringify(result)).not.toContain('secretAction');
    }
  });
  it('passes cancellation to the provider and exposes only a safe cancellation error', async () => {
    const controller = new AbortController();
    generateContent.mockImplementation(({ config }: { config: { abortSignal: AbortSignal } }) => new Promise((_resolve, reject) => {
      config.abortSignal.addEventListener('abort', () => reject(new Error('internal request details')), { once: true });
    }));
    const result = generateTutorReply({ ...input(), signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: 'TUTOR_CANCELLED', message: 'The tutoring request was cancelled.' });
    controller.abort(); await assertion;
    expect(generateContent.mock.calls[0]![0].config.abortSignal.aborted).toBe(true);
  });
  it('does not call providers when live configuration is absent or the request is already cancelled', async () => {
    await expect(generateTutorReply({ ...input(), apiKey: '' })).rejects.toMatchObject({ code: 'TUTOR_UNAVAILABLE' });
    await expect(generateTutorReply({ ...input(), signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'TUTOR_CANCELLED' });
    expect(generateContent).not.toHaveBeenCalled();
  });
  const submit = { name: 'submit_teaching_beat', args: { spokenText: 'Sunlight supplies energy. What supplies carbon?', displayText: 'Sunlight supplies energy. What supplies carbon?', conceptIds: ['light'], sourceRefs: [] } };
  const draw = { name: 'draw_shapes', args: { expectedRevision: 0, diagram: { id: 'energy-frame', title: 'Energy', template: 'process', nodes: [{ id: 'new-light', label: 'Sunlight', detail: 'An energy source', conceptIds: ['light'] }], edges: [] } } };
  const response = (calls: object[], signature = 'opaque-signature') => ({ functionCalls: calls, candidates: [{ content: { role: 'model', parts: calls.map(functionCall => ({ functionCall, thoughtSignature: signature })) } }] });
  it('produces editable validated visuals in one provider call and never mutates input', async () => {
    const request = input(), before = JSON.stringify(request.session);
    generateContent.mockResolvedValue(response([draw, { name: 'highlight_concepts', args: { shapeIds: ['new-light'] } }, submit]));
    const result = await generateTutorReply(request);
    expect(result.diagnostics).toMatchObject({ modelCalls: 1, toolCalls: 3, textOnlyFallback: false });
    expect(result.beats?.[0]?.boardCommands.some(command => command.type === 'upsert_node' && command.node.id === 'new-light')).toBe(true);
    expect(result.beats?.[0]?.highlightNodeIds).toEqual(['new-light']);
    expect(JSON.stringify(request.session)).toBe(before);
    const config = generateContent.mock.calls[0]![0].config;
    expect(config.toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
    const declarations = config.tools[0].functionDeclarations;
    expect(declarations.find((tool: { name: string }) => tool.name === 'draw_shapes').parametersJsonSchema.required).toEqual(['expectedRevision', 'diagram']);
    expect(declarations.find((tool: { name: string }) => tool.name === 'edit_shapes').parametersJsonSchema.required).toEqual(['expectedRevision', 'commands']);
  });
  it('preserves complete signed model content and function-call identity across the tool loop', async () => {
    const first = response([{ ...draw, id: 'function-1' }]);
    generateContent.mockResolvedValueOnce(first).mockResolvedValueOnce(response([{ ...submit, id: 'function-2' }]));
    await generateTutorReply(input());
    const history = generateContent.mock.calls[1]![0].contents;
    expect(history[1]).toBe(first.candidates[0]!.content);
    expect(history[1].parts[0].thoughtSignature).toBe('opaque-signature');
    expect(history[2].parts[0].functionResponse).toMatchObject({ id: 'function-1', name: 'draw_shapes' });
  });
  it('allows one repair, protects student shapes, and cannot narrate rejected drawing as successful', async () => {
    const request = input(); request.session.board.nodes[0]!.author = 'student';
    const invalid = { name: 'edit_shapes', args: { expectedRevision: 0, commands: [{ type: 'upsert_node', node: { ...request.session.board.nodes[0]!, label: 'Overwritten' } }] } };
    generateContent.mockResolvedValue(response([invalid]));
    const result = await generateTutorReply(request);
    expect(result.diagnostics).toMatchObject({ modelCalls: 2, repairAttempts: 1, textOnlyFallback: true });
    expect(result.beats?.[0]?.boardCommands).toEqual([]);
    expect(request.session.board.nodes[0]!.label).not.toBe('Overwritten');
    expect(result.text).toContain('No visual changes were applied');
  });
  it('rejects invented sources embedded into board objects before they can become trusted context', async () => {
    const request = input();
    const bad = { name: 'edit_shapes', args: { expectedRevision: 0, commands: [{ type: 'upsert_node', node: { ...request.session.board.nodes[0]!, sourceRefs: ['invented-source'] } }] } };
    generateContent.mockResolvedValue(response([bad, submit]));
    const result = await generateTutorReply({ ...request, limits: { maxModelCalls: 1, maxRepairAttempts: 0 } });
    expect(result.diagnostics?.textOnlyFallback).toBe(true);
    expect(result.beats?.flatMap(beat => beat.boardCommands)).toEqual([]);
  });
  it('clarifies stale or ambiguous selections without spending a provider call', async () => {
    const request = input();
    const result = await generateTutorReply({ ...request, selection: { shapeIds: ['plant'], conceptIds: [], boardRevision: 9 } });
    expect(result.text).toContain('select'); expect(generateContent).not.toHaveBeenCalled();
  });
  it('distinguishes provider limits, demand, authentication and model access without exposing raw errors', async () => {
    for (const [status, code] of [[429, 'TUTOR_RATE_LIMITED'], [503, 'TUTOR_BUSY'], [504, 'TUTOR_TIMEOUT'], [403, 'TUTOR_AUTH_FAILED'], [404, 'TUTOR_MODEL_UNAVAILABLE']] as const) {
      generateContent.mockRejectedValue({ status, message: 'provider-secret-token-and-content' });
      await expect(generateTutorReply(input())).rejects.toMatchObject({ code, providerStatus: status, failureCategory: 'provider-http', diagnostics: { modelCalls: 1 } });
      try { await generateTutorReply(input()); } catch (error) { expect(String(error)).not.toContain('provider-secret'); }
    }
  });
  it('reports bounded schema field paths and codes without rejected argument values or extra key names', async () => {
    generateContent.mockResolvedValue(response([{ name: 'draw_shapes', args: { expectedRevision: 0, diagram: { id: 'a', title: 'Test', template: 'process', nodes: [{ id: 'a', label: 123456789, secret_private_field: 'private-argument-text' }], edges: [] } } }]));
    const result = await generateTutorReply({ ...input(), limits: { maxModelCalls: 1, maxRepairAttempts: 0 } });
    const issues = result.diagnostics?.rejectedTools[0]?.issues;
    expect(issues).toContainEqual({ path: 'diagram.nodes.[].label', code: 'invalid_type' });
    expect(issues!.length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/123456789|secret_private_field|private-argument-text/);
  });
});
