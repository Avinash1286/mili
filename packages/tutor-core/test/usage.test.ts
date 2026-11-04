import { beforeEach, describe, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; }, FunctionCallingConfigMode: { VALIDATED: 'VALIDATED' } }));
import { SessionSettingsSchema } from '@tokai/contracts';
import { createLesson } from '../src/lessons';
import { generateTutorReply } from '../src/provider';
import { generateVisionExplanation } from '../src/vision';
import { generateLessonPlan } from '../src/learning';
import { geminiUsage, observeGeminiUsage } from '../src/usage';
const session = () => createLesson({ id: 'usage-lesson', topic: 'photosynthesis', mode: 'live', now: '2026-11-03T12:00:00.000Z', messageId: 'intro' });
const config = { apiKey: 'private-credential-not-logged', model: 'configured-model' };
const metadata = { modelVersion: 'provider-model-2026', responseId: 'provider-response-1', usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, cachedContentTokenCount: 8, thoughtsTokenCount: 3, toolUsePromptTokenCount: 2, totalTokenCount: 29 } };

describe('safe actual provider usage observations', () => {
  beforeEach(() => { generateContent.mockReset(); });
  it('projects only allowlisted real counts and treats missing/invalid values as unknown', () => {
    expect(geminiUsage(config.model, metadata)).toEqual({ provider: 'gemini', model: 'provider-model-2026', requestId: 'provider-response-1', inputTokens: 20, outputTokens: 4, cachedInputTokens: 8, thoughtTokens: 3, toolUseInputTokens: 2, totalTokens: 29 });
    expect(geminiUsage(config.model, { responseId: 'invalid\nsecret', modelVersion: 'bad model\ncontent', usageMetadata: { promptTokenCount: NaN, candidatesTokenCount: -1, cachedContentTokenCount: 0, totalTokenCount: 1.25 } })).toEqual({ provider: 'gemini', model: config.model, cachedInputTokens: 0 });
    expect(geminiUsage(config.model)).toEqual({ provider: 'gemini', model: config.model });
  });
  it('reports each model round separately rather than repeating a cumulative total', async () => {
    generateContent.mockResolvedValueOnce({ ...metadata, functionCalls: [{ name: 'highlight_concepts', args: { shapeIds: ['co2'] } }] });
    generateContent.mockResolvedValueOnce({ responseId: 'provider-response-2', usageMetadata: { promptTokenCount: 26, candidatesTokenCount: 7, totalTokenCount: 33 }, functionCalls: [{ name: 'submit_teaching_beat', args: { spokenText: 'Carbon dioxide supplies carbon. Which input supplies energy?', displayText: 'Carbon dioxide supplies carbon. Which input supplies energy?', conceptIds: ['co2'], sourceRefs: [] } }] });
    const onUsage = vi.fn();
    await generateTutorReply({ ...config, session: session(), text: 'Explain the inputs.', onUsage });
    expect(generateContent).toHaveBeenCalledTimes(2); expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls.map(([usage]) => [usage.requestId, usage.inputTokens, usage.outputTokens])).toEqual([['provider-response-1', 20, 4], ['provider-response-2', 26, 7]]);
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain(config.apiKey);
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain('Carbon dioxide');
  });
  it('records a paid response even when vision output fails its content schema', async () => {
    generateContent.mockResolvedValue({ ...metadata, text: JSON.stringify({ text: 'Private generated answer', unexpected: true }) });
    const onUsage = vi.fn();
    await expect(generateVisionExplanation({ ...config, session: session(), text: 'Private learner question', image: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=' }, onUsage })).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
    expect(onUsage).toHaveBeenCalledOnce(); expect(onUsage.mock.calls[0]![0].totalTokens).toBe(29);
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain('Private');
  });
  it('observes structured learning generation without copying prompts or generated plans', async () => {
    generateContent.mockResolvedValue({ ...metadata, text: JSON.stringify({ objectives: ['A private objective'], prerequisites: [], steps: [{ title: 'Private lesson', objective: 'Private source fact' }] }) });
    const onUsage = vi.fn();
    await generateLessonPlan({ ...config, topic: 'Private topic', settings: SessionSettingsSchema.parse({ preferences: {}, goal: 'Private goal', sourceIds: [], grounding: 'general' }), onUsage });
    expect(onUsage).toHaveBeenCalledOnce(); expect(onUsage.mock.calls[0]![0]).toEqual(geminiUsage(config.model, metadata));
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain('Private');
  });
  it('reports failed requests with absent token counts and no raw provider error', async () => {
    generateContent.mockRejectedValue(new Error('Secret provider response private-credential-not-logged'));
    const onUsage = vi.fn();
    await expect(generateTutorReply({ ...config, session: session(), text: 'Hello', onUsage })).rejects.toBeDefined();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ provider: 'gemini', model: config.model });
  });
  it('emits one unknown observation on cancellation and ignores late duplicate accounting', async () => {
    const controller = new AbortController(), onUsage = vi.fn();
    let complete!: (value: typeof metadata) => void;
    const pending = observeGeminiUsage({ model: config.model, onUsage, signal: controller.signal }, () => new Promise<typeof metadata>(resolve => { complete = resolve; }));
    controller.abort(); expect(onUsage).toHaveBeenCalledExactlyOnceWith({ provider: 'gemini', model: config.model });
    complete(metadata); await pending; expect(onUsage).toHaveBeenCalledTimes(1);
    const operation = vi.fn(async () => metadata);
    await expect(observeGeminiUsage({ model: config.model, onUsage, signal: AbortSignal.abort() }, operation)).rejects.toBeDefined();
    expect(operation).not.toHaveBeenCalled(); expect(onUsage).toHaveBeenCalledTimes(1);
  });
  it('does not let synchronous or asynchronous metadata sink errors alter the provider result', async () => {
    await expect(observeGeminiUsage({ model: config.model, onUsage: () => { throw new Error('Sink unavailable'); } }, async () => metadata)).resolves.toEqual(metadata);
    await expect(observeGeminiUsage({ model: config.model, onUsage: async () => { throw new Error('Sink unavailable'); } }, async () => metadata)).resolves.toEqual(metadata);
  });
});
