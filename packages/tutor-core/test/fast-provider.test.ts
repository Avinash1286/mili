import { afterEach, describe, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; }, FunctionCallingConfigMode: { VALIDATED: 'VALIDATED' } }));
import { createLesson, generateTutorReply, fastProvidersFromEnv } from '../src/index.js';

const session = () => createLesson({ id: 'fast', topic: 'photosynthesis', mode: 'live', now: '2026-11-04T12:00:00.000Z', messageId: 'intro' });
const submit = { spokenText: 'Sunlight supplies energy. What supplies carbon?', displayText: 'Sunlight supplies energy. What supplies carbon?', conceptIds: ['light'], sourceRefs: [] };
const completion = (args: object) => new Response(JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-oss-120b', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'submit_teaching_beat', arguments: JSON.stringify(args) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });

describe('fast tutor providers', () => {
  afterEach(() => { vi.unstubAllGlobals(); generateContent.mockReset(); });
  it('reads configured providers in order and ignores missing keys', () => {
    expect(fastProvidersFromEnv({ GROQ_API_KEY: 'g', CEREBRAS_API_KEY: 'c' }).map(item => item.provider)).toEqual(['groq', 'cerebras']);
    expect(fastProvidersFromEnv({ GROQ_API_KEY: 'g' })).toEqual([{ provider: 'groq', apiKey: 'g', model: 'openai/gpt-oss-120b', timeoutMs: 12000 }]);
    expect(fastProvidersFromEnv({})).toEqual([]);
  });
  it('teaches through an OpenAI-compatible tool call without Gemini', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('draw_shapes');
      expect(body.tools[0].function.parameters).not.toHaveProperty('$schema');
      expect(body.reasoning_effort).toBe('low');
      return completion(submit);
    });
    vi.stubGlobal('fetch', fetch);
    const onUsage = vi.fn();
    const result = await generateTutorReply({ session: session(), text: 'Explain energy', apiKey: '', model: '', onUsage, fastProviders: [{ provider: 'cerebras', apiKey: 'key', model: 'gpt-oss-120b' }] });
    expect(result.text).toContain('Sunlight supplies energy');
    expect(result.diagnostics).toMatchObject({ provider: 'cerebras', modelCalls: 1, textOnlyFallback: false });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ provider: 'cerebras', model: 'gpt-oss-120b', requestId: 'chatcmpl-1', inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('tries Groq, then Cerebras, then Gemini even with reversed provider input', async () => {
    const order: string[] = [];
    generateContent.mockImplementation(async () => {
      order.push('gemini');
      const call = { name: 'submit_teaching_beat', args: submit };
      return { functionCalls: [call], candidates: [{ content: { role: 'model', parts: [{ functionCall: call }] } }] };
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      order.push(new URL(url).hostname === 'api.groq.com' ? 'groq' : 'cerebras');
      return new Response('{}', { status: 503 });
    }));
    const result = await generateTutorReply({ session: session(), text: 'Explain energy', apiKey: 'gemini', model: 'gemini-model', fastProviders: [{ provider: 'cerebras', apiKey: 'c', model: 'm' }, { provider: 'groq', apiKey: 'g', model: 'm' }] });
    expect(order).toEqual(['groq', 'cerebras', 'gemini']);
    expect(result.text).toContain('Sunlight supplies energy');
    expect(result.diagnostics?.provider).toBe('gemini');
    expect(result.diagnostics?.fallbacks).toEqual([{ provider: 'groq', code: 'TUTOR_BUSY' }, { provider: 'cerebras', code: 'TUTOR_BUSY' }]);
  });
  it('stops at a successful Groq reply without calling Cerebras or Gemini', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(new URL(url).hostname).toBe('api.groq.com');
      return completion(submit);
    });
    vi.stubGlobal('fetch', fetch);
    const result = await generateTutorReply({ session: session(), text: 'Explain energy', apiKey: 'gemini', model: 'gemini-model', fastProviders: fastProvidersFromEnv({ GROQ_API_KEY: 'g', CEREBRAS_API_KEY: 'c' }) });
    expect(result.diagnostics?.provider).toBe('groq');
    expect(fetch).toHaveBeenCalledOnce();
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('does not fall back after learner cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetch);
    generateContent.mockImplementation(({ config }) => new Promise((_resolve, reject) => {
      config.abortSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const reply = generateTutorReply({ session: session(), text: 'Explain', apiKey: 'gemini', model: 'gemini-model', signal: controller.signal, fastProviders: [{ provider: 'groq', apiKey: 'g', model: 'm' }] });
    const assertion = expect(reply).rejects.toMatchObject({ code: 'TUTOR_CANCELLED' });
    controller.abort(); await assertion;
    expect(generateContent).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
