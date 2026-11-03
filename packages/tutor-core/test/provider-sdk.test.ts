import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLesson } from '../src/lessons';
import { generateTutorReply } from '../src/provider';

describe('real SDK teaching request serialization (offline)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('serializes every declared tool and processes a validated diagram without a network request', async () => {
    const draw = { name: 'draw_shapes', args: { expectedRevision: 0, diagram: { id: 'sdk-frame', title: 'Energy flow', template: 'process', nodes: [{ id: 'sdk-light', label: 'Light', detail: 'Energy input', conceptIds: ['light'] }, { id: 'sdk-sugar', label: 'Sugar', detail: 'Chemical energy', conceptIds: ['sugar'] }], edges: [{ id: 'sdk-edge', from: 'sdk-light', to: 'sdk-sugar', label: 'energy stored' }] } } };
    const submit = { name: 'submit_teaching_beat', args: { spokenText: 'Light energy helps build sugars. Which part supplies carbon?', displayText: 'Light energy helps build sugars. Which part supplies carbon?', conceptIds: ['light', 'sugar'], sourceRefs: [] } };
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].functionDeclarations).toHaveLength(7);
      const diagram = body.tools[0].functionDeclarations.find((item: { name: string }) => item.name === 'draw_shapes');
      expect(diagram.parametersJsonSchema.required).toEqual(['expectedRevision', 'diagram']);
      expect(body.generationConfig.maxOutputTokens).toBe(4096);
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: draw }, { functionCall: submit }] } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const session = createLesson({ id: 'sdk-test', topic: 'photosynthesis', mode: 'live', now: '2026-11-03T12:00:00.000Z', messageId: 'intro' });
    const result = await generateTutorReply({ session, text: 'Show the energy flow.', apiKey: 'offline-fixture-key', model: 'mock-model', limits: { maxModelCalls: 1, maxRepairAttempts: 0 } });
    expect(fetch).toHaveBeenCalledOnce(); expect(result.diagnostics).toMatchObject({ modelCalls: 1, toolCalls: 2, textOnlyFallback: false });
    expect(result.beats?.[0].boardCommands.some(command => command.type === 'upsert_node' && command.node.id === 'sdk-light')).toBe(true);
  });
});
