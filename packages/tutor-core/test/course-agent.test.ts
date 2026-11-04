import { describe, expect, it } from 'vitest';
import { validateCourseScript, validateCourseStep } from '@milli/contracts';
import {
  buildFallbackCourseScript,
  buildFallbackChapterSteps,
  buildDeterministicRemedialStep,
  deterministicAgenticTurn,
  getAuthoredCourseScript,
} from '../src/index.js';

describe('adaptive agentic course engine', () => {
  it('validates all authored courses and fallback chapter steps', () => {
    for (const topic of ['photosynthesis', 'fractions', 'solar-system', 'circuits']) {
      const authored = getAuthoredCourseScript(topic);
      expect(authored).toBeDefined();
      expect(validateCourseScript(authored!)).toBeUndefined();
    }
    const fallback = buildFallbackCourseScript('quantum tunneling', 'Quantum Tunneling');
    expect(validateCourseScript(fallback)).toBeUndefined();
    const steps = buildFallbackChapterSteps('quantum tunneling', 'Wavefunction decay', 'Understand barrier penetration', 1);
    expect(steps.length).toBe(2);
    for (const step of steps) {
      expect(validateCourseStep(step)).toBeUndefined();
    }
  });

  it('handles off-script side questions, spoken answers, and remedial step creation deterministically', () => {
    const course = getAuthoredCourseScript('solar-system')!;
    const step1 = course.chapters[0]!.steps[0]!;
    const step2 = course.chapters[0]!.steps[1]!;

    // 1. Off-script learner question -> answers question AND bridges back to active syllabus step
    const side = deterministicAgenticTurn(course, step1, {
      stepId: step1.id,
      event: 'learner-message',
      mode: 'spoken',
      learnerText: 'Wait, why did Julius Caesar invent leap years?',
      attempts: 0,
      stage: 'practice',
    });
    expect(side.intent).toBe('side-question');
    expect(side.bridgeText).toBeTruthy();
    expect(side.spokenText).toContain('bringing us back on track');

    // 2. Spoken answer matching expected slots -> marks step solved!
    const spoken = deterministicAgenticTurn(course, step2, {
      stepId: step2.id,
      event: 'learner-message',
      mode: 'spoken',
      learnerText: 'The answers are 2 and 6',
      attempts: 0,
      stage: 'practice',
    });
    expect(spoken.intent).toBe('spoken-answer');
    expect(spoken.markStepSolved).toBe(true);

    // 3. Repeated struggle -> builds a valid remedial stepping-stone step
    const remedial = deterministicAgenticTurn(course, step2, {
      stepId: step2.id,
      event: 'check',
      mode: 'ui',
      correct: false,
      attempts: 2,
      stage: 'practice',
    });
    expect(remedial.intent).toBe('remedial');
    expect(remedial.insertedStep).toBeDefined();
    expect(remedial.insertedStep?.remedialFor).toBe(step2.id);
    expect(validateCourseStep(remedial.insertedStep!)).toBeUndefined();

    const directRem = buildDeterministicRemedialStep(step1, new Set([step1.id]));
    expect(validateCourseStep(directRem)).toBeUndefined();
  });
});
