import { beforeEach, describe, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; } }));
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
    const context = JSON.parse(generateContent.mock.calls[0]![0].contents);
    expect(context.recentConversation[1]).toMatchObject({ delivery: 'interrupted', playedMs: 350 });
    expect(context.recentConversation[1]).not.toHaveProperty('text');
    expect(context.recentConversation[1].note).toContain('Exact heard words are unknown');
    expect(context.recentConversation[2].text).toBe('A confirmed delivered explanation');
  });
  it('rejects oversized speech and extra untrusted response fields instead of truncating or falling back', async () => {
    generateContent.mockResolvedValueOnce({ text: JSON.stringify({ text: 'a'.repeat(1201) }) });
    await expect(generateTutorReply(input())).rejects.toMatchObject({ code: 'TUTOR_INVALID_RESPONSE' });
    generateContent.mockResolvedValueOnce({ text: JSON.stringify({ text: 'A short answer', secretAction: 'execute' }) });
    await expect(generateTutorReply(input())).rejects.toMatchObject({ code: 'TUTOR_INVALID_RESPONSE' });
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
});
