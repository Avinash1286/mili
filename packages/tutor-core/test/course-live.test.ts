import { afterEach, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; }, ThinkingLevel: { MINIMAL: 'MINIMAL' } }));
import { runAgenticCourseTurn } from '../src/course.js';
import { getAuthoredCourseScript } from '../src/course-samples.js';
const course = getAuthoredCourseScript('circuits')!;
const input = () => ({ course, chapterIndex: 0, step: course.chapters[0]!.steps[0]!, mode: 'live' as const,
  apiKey: 'test', model: 'gemini-3.5-flash-lite', request: { stepId: 'ci-1', event: 'learner-message' as const,
    mode: 'spoken' as const, learnerText: 'Does the battery make electrons?', attempts: 0, stage: 'teach' as const } });
afterEach(() => generateContent.mockReset());
it('uses a compact conversational schema and low-latency thinking while preserving grounded feedback', async () => {
  generateContent.mockResolvedValue({ text: JSON.stringify({ intent: 'side-question', spokenText: 'The electrons are already in the wire. The battery pushes them around the loop.', displayText: 'The battery pushes existing electrons.', bridgeText: 'What happens if we break the return wire?', highlight: ['n-bat'] }) });
  const reply = await runAgenticCourseTurn(input());
  expect(reply.source).toBe('live');
  expect(reply.markStepSolved).toBe(false);
  expect(reply.spokenText).toContain('What happens if we break the return wire?');
  const config = generateContent.mock.calls[0]![0].config;
  expect(config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  const schema = JSON.parse(config.systemInstruction.split('JSON schema: ')[1]);
  expect(schema.properties).not.toHaveProperty('remedialStep');
  expect(schema.properties).not.toHaveProperty('clarifyVisual');
});
it('does not pretend prepared reference text answers an arbitrary live question after provider failure', async () => {
  generateContent.mockRejectedValue(new Error('Unavailable'));
  const onFallback = vi.fn();
  const reply = await runAgenticCourseTurn({ ...input(), onFallback });
  expect(reply.source).toBe('prepared');
  expect(reply.spokenText).toContain("couldn't get a live reply");
  expect(reply.markStepSolved).toBe(false);
  expect(reply.spokenText).not.toContain('Great question');
  expect(onFallback).toHaveBeenCalledOnce();
});
