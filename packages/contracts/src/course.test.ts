import { describe, expect, it } from 'vitest';
import {
  CourseScriptSchema, CourseAnswerSchema, compileMathExpr, evalMathExpr,
  gradeCourseInteraction, isCourseAnswerReady, revealCourseAnswer, parseTemplateTokens,
  splitStepTeaching, summarizeCourseAnswer, validateCourseStep, validateCourseScript, stepXp,
} from './index';

describe('course contracts and deterministic engine', () => {
  it('evaluates math expressions safely without eval', () => {
    expect(evalMathExpr('2 + 3 * 4')).toBe(14);
    expect(evalMathExpr('(2 + 3) * 4')).toBe(20);
    expect(evalMathExpr('2^3')).toBe(8);
    expect(evalMathExpr('a * sin(pi / 2) + b', { a: 5, b: 2 })).toBeCloseTo(7, 6);
    expect(evalMathExpr('2x + 1', { x: 4 })).toBe(9);
    expect(evalMathExpr('1 / 0')).toBeNaN();
    expect(() => compileMathExpr('alert(1)')).toThrow();
  });

  it('grades every step interaction type and verifies revealed answers', () => {
    const script = CourseScriptSchema.parse({
      version: 1, title: 'Periodic phenomena', topic: 'periodic', provenance: 'authored',
      summary: 'Patterns repeat with a period.',
      chapters: [{
        id: 'ch-1', title: 'Peaks and period', goal: 'Find repeating peaks.', status: 'ready',
        steps: [
          { id: 's-concept', kind: 'concept', body: 'Many quantities repeat on a regular cycle.', explanation: 'A repeating pattern is periodic.' },
          { id: 's-mark', kind: 'question', body: 'Mark the points where search volume reaches 9 million.',
            visual: { kind: 'plot', id: 'p-1', alt: 'Peaks at t=2 and t=6', x: { min: 0, max: 10, step: 1 }, y: { min: 0, max: 10, step: 1 }, points: [{ id: 'pt1', x: 2, y: 9 }, { id: 'pt2', x: 6, y: 9 }] },
            interaction: { type: 'mark-points', targets: [{ x: 2, y: 9 }, { x: 6, y: 9 }], tolerance: 0.4 },
            explanation: 'Peaks of 9 occur at t = 2 and t = 6.' },
          { id: 's-tiles', kind: 'question', body: 'Fill in the coordinates of the two tallest peaks.',
            interaction: { type: 'fill-tiles', template: '({a}, 9) and ({b}, 9)', tiles: [{ id: 't2', text: '2' }, { id: 't4', text: '4' }, { id: 't6', text: '6' }], slots: [{ id: 'a', accept: ['t2'] }, { id: 'b', accept: ['t6'] }] },
            explanation: 'The first peak is at t = 2, and 4 years later is t = 6.' },
          { id: 's-input', kind: 'question', body: 'How many years pass between identical peaks?',
            interaction: { type: 'fill-input', template: 'Period = {p} years', slots: [{ id: 'p', accept: ['4', 'four'], numeric: { value: 4, tolerance: 0 } }] },
            explanation: '6 - 2 = 4 years.' },
          { id: 's-mcq', kind: 'question', body: 'When is the next peak after t = 6?',
            interaction: { type: 'mcq', options: [{ id: 'o8', text: 't = 8' }, { id: 'o10', text: 't = 10' }], correct: ['o10'], feedback: [{ optionId: 'o8', text: 'Add 4 years, not 2.' }] },
            explanation: '6 + 4 = 10.' },
          { id: 's-tf', kind: 'question', body: 'A period of 4 years means every year looks the same.',
            interaction: { type: 'true-false', answer: false }, explanation: 'The pattern repeats every 4 years, not every 1 year.' },
          { id: 's-order', kind: 'question', body: 'Order the steps.',
            interaction: { type: 'order', items: [{ id: 'i1', text: 'First' }, { id: 'i2', text: 'Second' }, { id: 'i3', text: 'Third' }] },
            explanation: 'First, second, third.' },
          { id: 's-match', kind: 'question', body: 'Match each term.',
            interaction: { type: 'match', pairs: [{ id: 'm1', left: 'Peak', right: 'Highest value' }, { id: 'm2', left: 'Period', right: 'Repeat interval' }] },
            explanation: 'Peak is highest value; period is repeat interval.' },
          { id: 's-cat', kind: 'question', body: 'Sort the events.',
            interaction: { type: 'categorize', buckets: [{ id: 'b1', label: 'Periodic' }, { id: 'b2', label: 'One-off' }], items: [{ id: 'c1', text: 'Leap year', bucket: 'b1' }, { id: 'c2', text: 'Sunrise', bucket: 'b1' }, { id: 'c3', text: ' Comet collision', bucket: 'b2' }] },
            explanation: 'Leap years and sunrises repeat on a schedule.' },
          { id: 's-slider', kind: 'question', body: 'Set the amplitude to 9.',
            interaction: { type: 'slider', label: 'Amplitude A', min: 1, max: 10, step: 1, initial: 4, accept: { min: 9, max: 9 } },
            explanation: 'An amplitude of 9 reaches height 9.' },
        ],
      }],
    });
    expect(validateCourseScript(script)).toBeUndefined();
    for (const step of script.chapters[0].steps) {
      expect(validateCourseStep(step)).toBeUndefined();
      if (!step.interaction) continue;
      const revealed = CourseAnswerSchema.parse(revealCourseAnswer(step.interaction));
      expect(isCourseAnswerReady(step.interaction, revealed)).toBe(true);
      expect(gradeCourseInteraction(step.interaction, revealed).correct).toBe(true);
    }
    expect(parseTemplateTokens('({a}, 9)')).toEqual([{ kind: 'text', text: '(' }, { kind: 'slot', id: 'a' }, { kind: 'text', text: ', 9)' }]);
    expect(stepXp(1, false)).toBe(15);
    expect(stepXp(2, false)).toBe(10);
    expect(stepXp(1, true)).toBe(0);

    const split = splitStepTeaching({
      id: 's-split',
      kind: 'question',
      title: 'Peaks',
      body: 'Every 4 years, search volume spikes to **9 million**.\n\nMark the two tallest peaks on the graph.',
      interaction: { type: 'true-false', answer: true },
      explanation: 'Peaks repeat every 4 years.',
    });
    expect(split.conceptText).toContain('Every 4 years');
    expect(split.questionPrompt).toBe('Mark the two tallest peaks on the graph.');
    expect(split.conceptSpeech).not.toContain('**');

    const summary = summarizeCourseAnswer(
      { type: 'mcq', multiple: false, options: [{ id: 'a', text: 'Chloroplast' }, { id: 'b', text: 'Nucleus' }], correct: ['a'], feedback: [] },
      { type: 'mcq', selected: ['b'] },
    );
    expect(summary).toContain('Nucleus');
  });
});
