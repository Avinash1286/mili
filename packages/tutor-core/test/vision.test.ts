import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; } }));
import { generateVisionExplanation, validateVisionImage } from '../src/vision.js';
import { createLesson } from '../src/lessons.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const input = () => ({ session: createLesson({ id: 'lesson', topic: 'fractions', mode: 'live', now: '2026-11-03T12:00:00.000Z', messageId: 'intro' }), text: 'What does this drawing show?', image: { mimeType: 'image/png' as const, data: png }, apiKey: 'mock-key', model: 'mock-model' });
describe('explicit board image sharing', () => {
  beforeEach(() => generateContent.mockReset());
  it('accepts a bounded PNG and rejects URLs, truncation and oversized decoded dimensions before model use', async () => {
    expect(validateVisionImage(input().image)).toEqual({ width: 1, height: 1 });
    expect(() => validateVisionImage({ mimeType: 'image/png', data: 'https://example.com/private.png' })).toThrow();
    const bytes = Buffer.from(png, 'base64'); bytes.writeUInt32BE(100000, 16);
    await expect(generateVisionExplanation({ ...input(), image: { mimeType: 'image/png', data: bytes.toString('base64') } })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(() => validateVisionImage({ mimeType: 'image/png', data: Buffer.from(png, 'base64').subarray(0, 40).toString('base64') })).toThrow();
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('sends only the chosen crop and bounded semantic context, with no model tools', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ text: 'The crop is unclear. Can you describe the parts?' }) });
    await expect(generateVisionExplanation(input())).resolves.toMatchObject({ text: expect.stringContaining('unclear') });
    const request = generateContent.mock.calls[0]![0];
    expect(request.contents[0].parts[1].inlineData).toEqual(input().image); expect(request.config.tools).toBeUndefined();
    expect(JSON.stringify(request.contents)).not.toContain('mock-key');
  });
  it('sanitizes provider failures and rejects invented result fields', async () => {
    generateContent.mockRejectedValueOnce(new Error('private provider details'));
    await expect(generateVisionExplanation(input())).rejects.toMatchObject({ code: 'VISION_FAILED' });
    generateContent.mockResolvedValueOnce({ text: JSON.stringify({ text: 'A picture', action: 'execute' }) });
    await expect(generateVisionExplanation(input())).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
  });
  it('does not transmit an already cancelled image request', async () => {
    await expect(generateVisionExplanation({ ...input(), signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'VISION_CANCELLED' });
    expect(generateContent).not.toHaveBeenCalled();
  });
});
