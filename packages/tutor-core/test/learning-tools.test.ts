import { beforeEach, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; }, FunctionCallingConfigMode: { VALIDATED: 'VALIDATED' } }));
import { createLesson, generateTutorReply, type TutorLearningContext } from '../src/index';
import type { TutorLearningAction } from '@tokai/contracts';
const input = () => ({ session: createLesson({ id: 'tool-lesson', topic: 'photosynthesis', mode: 'live', now: '2026-11-04T12:00:00.000Z', messageId: 'intro' }), text: 'Ask a saved question.', apiKey: 'offline-fixture', model: 'offline-model', limits: { maxModelCalls: 1, maxRepairAttempts: 0 } });
const submit = { name: 'submit_teaching_beat', args: { spokenText: 'The model says you mastered the entire subject.', displayText: 'The model says you mastered the entire subject.', conceptIds: [], sourceRefs: [] } };
beforeEach(() => { generateContent.mockReset(); });
it('stages canonical async questions and strips model narration from learning actions', async () => {
  const prepare = vi.fn(async (_action: TutorLearningAction) => ({ spokenText: 'Which input supplies carbon?', displayText: 'Which input supplies carbon? Open the saved question.' }));
  generateContent.mockResolvedValue({ functionCalls: [{ name: 'ask_question', args: { assessmentId: 'stored-question', assessmentVersion: '1' } }, submit] });
  const reply = await generateTutorReply({ ...input(), learning: { assessments: [], prepare } });
  expect(prepare).toHaveBeenCalledExactlyOnceWith({ type: 'ask_question', assessmentId: 'stored-question', assessmentVersion: '1' });
  expect(reply.text).toBe('Which input supplies carbon? Open the saved question.'); expect(reply.beats![0]!.learningAction?.type).toBe('ask_question');
  expect(reply.text).not.toContain('mastered');
});
it('does not advertise or execute learning tools when the server context is absent', async () => {
  generateContent.mockResolvedValue({ functionCalls: [{ name: 'ask_question', args: { assessmentId: 'invented', assessmentVersion: '1' } }, submit] });
  const reply = await generateTutorReply(input());
  const names = generateContent.mock.calls[0]![0].config.tools[0].functionDeclarations.map((item: { name: string }) => item.name);
  expect(names).toHaveLength(7); expect(names).not.toContain('ask_question'); expect(reply.beats!.some(beat => beat.learningAction)).toBe(false);
});
it('rejects model-authored answers and scores before the trusted preparer runs', async () => {
  const prepare = vi.fn<TutorLearningContext['prepare']>();
  generateContent.mockResolvedValue({ functionCalls: [{ name: 'evaluate_answer', args: { presentationId: 'shown', answer: 'fabricated', correctness: 'correct' } }, submit] });
  const reply = await generateTutorReply({ ...input(), learning: { assessments: [], submittedPresentationId: 'shown', prepare } });
  expect(prepare).not.toHaveBeenCalled(); expect(reply.beats!.some(beat => beat.learningAction)).toBe(false); expect(reply.text).not.toContain('mastered');
});
it('allows at most one prepared learning action across both teaching beats', async () => {
  const prepare = vi.fn(async () => ({ spokenText: 'A saved question is ready.', displayText: 'A saved question is ready.' }));
  generateContent.mockResolvedValue({ functionCalls: [{ name: 'ask_question', args: { assessmentId: 'stored-question', assessmentVersion: '1' } }, submit, { name: 'generate_flashcards', args: {} }, submit] });
  const reply = await generateTutorReply({ ...input(), learning: { assessments: [], prepare } });
  expect(prepare).toHaveBeenCalledTimes(1); expect(reply.beats!.filter(beat => beat.learningAction)).toHaveLength(1); expect(reply.diagnostics!.rejectedTools.some(item => item.code === 'LEARNING_ACTION_LIMIT')).toBe(true);
});
