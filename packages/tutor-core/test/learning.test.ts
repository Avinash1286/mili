import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent }; }, FunctionCallingConfigMode: { VALIDATED: 'VALIDATED' } }));
import { LearnerPreferencesSchema, SessionSettingsSchema, type ExplanationRubric, type LearningSourceRef, type PublicAssessment } from '@milli/contracts';
import { createLesson } from '../src/lessons';
import { createGeminiRubricGrader, generateAssessment, generateLearningCards, generateLessonPlan } from '../src/learning';

const config = { apiKey: 'fake-key-never-transmitted', model: 'offline-test-model' };
const settings = SessionSettingsSchema.parse({ preferences: LearnerPreferencesSchema.parse({ level: 'beginner', lessonMinutes: 15 }), goal: 'Understand plant energy.', sourceIds: [], grounding: 'general' });
const session = () => ({ ...createLesson({ id: 'session', topic: 'photosynthesis', mode: 'live', now: '2026-11-03T12:00:00.000Z', messageId: 'intro' }), settings });
const rubric: ExplanationRubric = { version: '1', acceptedAnswers: [], contradictions: [], criteria: [{ id: 'energy', description: 'Energy role', expected: 'Light supplies energy.', required: true }, { id: 'matter', description: 'Matter role', expected: 'Carbon dioxide supplies carbon.', required: true }] };
const question: PublicAssessment = { id: 'question', version: '1', packId: 'custom', kind: 'short-answer', conceptIds: ['light'], objectiveIds: ['objective-1'], prompt: 'Explain the inputs.', responseInstructions: 'Use your own words.', hintCount: 2 };
const answer = 'Light gives energy, while carbon dioxide provides carbon.';
const goodJudgment = { correctness: 'correct', reasoning: 'clear', confidence: 'high', criteria: [{ criterionId: 'energy', judgment: 'met', evidenceQuote: 'Light gives energy' }, { criterionId: 'matter', judgment: 'met', evidenceQuote: 'carbon dioxide provides carbon' }], feedback: 'Both roles are clear.', misconceptionIds: [] };
const reference: LearningSourceRef = { sourceId: 'upload', sourceVersion: '2', title: 'Owned source', chunkId: 'chunk-1', snippet: 'Light supplies energy.' };
const draft = () => ({ prompt: 'Which input provides energy?', options: [{ id: 'light', label: 'Light' }, { id: 'water', label: 'Water' }], responseInstructions: 'Choose one.', hints: [{ id: 'hint-1', text: 'Separate matter from energy.' }], explanation: 'Light provides energy.', grading: { type: 'choice', correctOptionIds: ['light'] }, sourceKeys: [] });

describe('bounded Gemini learning adapters', () => {
  beforeEach(() => { generateContent.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });
  it('returns uncertainty without calls when grading is unconfigured', async () => {
    const grade = createGeminiRubricGrader({ ...config, apiKey: '' });
    expect(await grade({ assessment: question, rubric, answer, sourceRefs: [] })).toMatchObject({ correctness: 'uncertain', confidence: 'low' });
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('sends one JSON-only bounded request and verifies rubric evidence', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(goodJudgment) });
    const result = await createGeminiRubricGrader(config)({ assessment: question, rubric, answer, sourceRefs: [] });
    expect(result.correctness).toBe('correct'); expect(generateContent).toHaveBeenCalledTimes(1);
    const request = generateContent.mock.calls[0][0];
    expect(request.config.responseMimeType).toBe('application/json'); expect(request.config.maxOutputTokens).toBe(4096);
    expect(request.config).not.toHaveProperty('tools'); expect(JSON.stringify(request.contents)).not.toContain(config.apiKey);
    expect(request.config.systemInstruction).toContain('untrusted data');
  });
  it.each([
    { ...goodJudgment, confidence: 'low' }, { ...goodJudgment, correctness: 'incorrect' },
    { ...goodJudgment, criteria: [{ ...goodJudgment.criteria[0], evidenceQuote: 'Words not in the answer' }, goodJudgment.criteria[1]] },
    { ...goodJudgment, criteria: [goodJudgment.criteria[0], goodJudgment.criteria[0]] },
    { ...goodJudgment, misconceptionIds: ['invented-misconception'] },
    { ...goodJudgment, hiddenAction: 'send-data' },
  ])('keeps unverifiable rubric judgments uncertain', async result => {
    generateContent.mockResolvedValue({ text: JSON.stringify(result) });
    expect((await createGeminiRubricGrader(config)({ assessment: question, rubric, answer, sourceRefs: [] })).correctness).toBe('uncertain');
  });
  it('handles a hung provider with a deadline and aborts the request even if the provider ignores cancellation', async () => {
    vi.useFakeTimers(); generateContent.mockImplementation(() => new Promise(() => {}));
    const pending = createGeminiRubricGrader({ ...config, timeoutMs: 1000 })({ assessment: question, rubric, answer, sourceRefs: [] });
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).correctness).toBe('uncertain'); expect(generateContent.mock.calls[0][0].config.abortSignal.aborted).toBe(true);
  });
  it('cancels immediately without accepting late provider output', async () => {
    const controller = new AbortController(); let complete!: (response: unknown) => void;
    generateContent.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = createGeminiRubricGrader({ ...config, signal: controller.signal })({ assessment: question, rubric, answer, sourceRefs: [] });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'LEARNING_CANCELLED' });
    controller.abort(); complete({ text: JSON.stringify(goodJudgment) }); await rejection;
  });
  it('keeps plan authority in server settings and labels it generated', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ objectives: ['Distinguish energy from material.'], prerequisites: ['Know that plants contain cells.'], steps: [{ title: 'Trace inputs', objective: 'Compare light with carbon dioxide.' }] }) });
    const plan = await generateLessonPlan({ ...config, topic: 'Plants', settings });
    expect(plan).toMatchObject({ goal: settings.goal, level: 'beginner', minutes: 15, provenance: 'generated', status: 'ready' });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it('requires usable evidence for source-only generation before spending a request', async () => {
    const sourceSettings = { ...settings, grounding: 'sources-only' as const };
    await expect(generateLessonPlan({ ...config, topic: 'Plants', settings: sourceSettings })).rejects.toMatchObject({ code: 'LEARNING_SOURCE_REQUIRED' });
    await expect(generateAssessment({ ...config, session: { ...session(), settings: sourceSettings }, id: 'new', kind: 'multiple-choice' })).rejects.toMatchObject({ code: 'LEARNING_SOURCE_REQUIRED' });
    expect(generateContent).not.toHaveBeenCalled();
  });
  it('owns generated IDs/versions and binds citations to canonical supplied metadata', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ ...draft(), sourceKeys: ['source-1'] }) });
    const result = await generateAssessment({ ...config, session: session(), id: 'server-owned-id', kind: 'multiple-choice', sourceRefs: [reference] });
    expect(result).toMatchObject({ id: 'server-owned-id', version: 'generated-v1', packId: 'session:session', sourceRefs: [reference] });
    generateContent.mockResolvedValue({ text: JSON.stringify({ ...draft(), sourceKeys: ['invented-source'] }) });
    await expect(generateAssessment({ ...config, session: session(), id: 'new', kind: 'multiple-choice', sourceRefs: [reference] })).rejects.toMatchObject({ code: 'LEARNING_INVALID_RESPONSE' });
  });
  it('rejects mismatched answer formats, invalid unit factors and unsupported formula evaluation', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(draft()) });
    await expect(generateAssessment({ ...config, session: session(), id: 'new', kind: 'numeric' })).rejects.toMatchObject({ code: 'LEARNING_INVALID_RESPONSE' });
    for (const expected of ['1/0', '2+3', '1.2/2', '1e99']) {
      generateContent.mockResolvedValue({ text: JSON.stringify({ ...draft(), options: undefined, grading: { type: 'numeric', expected, canonicalUnit: 'A', acceptedUnits: [{ unit: 'A', factor: '1' }], exact: true, unitRequired: true, absoluteTolerance: 0, relativeTolerance: 0 } }) });
      await expect(generateAssessment({ ...config, session: session(), id: 'new', kind: 'numeric' })).rejects.toMatchObject({ code: 'LEARNING_INVALID_RESPONSE' });
    }
  });
  it('does not feed interrupted or unplayed narration into generated assessments', async () => {
    const lesson = session(); lesson.teachingBeats = [{ beatId: 'partial', turnId: 'turn', messageId: 'message', outputEpoch: 1, status: 'interrupted', expectedBoardRevision: 0, spokenText: 'Do not treat this as heard', displayText: 'display', conceptIds: [], boardCommands: [], highlightNodeIds: [], sourceRefs: [], playedMs: 100 }];
    generateContent.mockResolvedValue({ text: JSON.stringify(draft()) });
    await generateAssessment({ ...config, session: lesson, id: 'new', kind: 'multiple-choice' });
    const context = JSON.parse(generateContent.mock.calls[0][0].contents[0].parts[0].text);
    expect(context.completedNarration).toEqual([]); expect(JSON.stringify(context)).not.toContain('Do not treat this as heard');
  });
  it('generates canonical cloze content and rejects invented concepts or spoken rubrics', async () => {
    const card = { kind: 'cloze', front: 'inconsistent front', back: 'inconsistent back', hint: 'Think energy.', explanation: 'Light provides energy.', conceptIds: ['light'], sourceKeys: [], cloze: { before: 'Light supplies ', answer: 'energy', after: '.' } };
    generateContent.mockResolvedValue({ text: JSON.stringify({ cards: [card] }) });
    const result = await generateLearningCards({ ...config, session: session() });
    expect(result[0].back).toBe('Light supplies energy.'); expect(result[0].sourceRefs).toEqual([]);
    for (const invalid of [{ ...card, conceptIds: ['not-in-session'] }, { ...card, kind: 'spoken-recall', rubricAssessmentId: 'invented' }]) {
      generateContent.mockResolvedValue({ text: JSON.stringify({ cards: [invalid] }) });
      await expect(generateLearningCards({ ...config, session: session() })).rejects.toMatchObject({ code: 'LEARNING_INVALID_RESPONSE' });
    }
  });
  it('does not retry after provider limits or disclose provider messages', async () => {
    generateContent.mockRejectedValue({ status: 429, message: 'secret internal source content' });
    const pending = generateLessonPlan({ ...config, topic: 'Plants', settings });
    await expect(pending).rejects.toMatchObject({ code: 'LEARNING_RATE_LIMITED' });
    try { await pending; } catch (error) { expect(String(error)).not.toContain('secret'); }
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
