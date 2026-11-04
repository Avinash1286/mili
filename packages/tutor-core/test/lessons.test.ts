import { describe, it, expect } from 'vitest';
import { SessionSchema, TOPICS, type Session } from '@milli/contracts';
import { createLesson, sampleReply, sampleTeachingReply, summarizeSession, LESSONS } from '../src/index.js';

function respond(session: Session, text: string, selectedNodeId?: string) {
  const response = sampleReply(session, text, selectedNodeId);
  const createdAt = new Date().toISOString();
  session.messages.push({ id: `${session.messages.length}-student`, role: 'student', text, createdAt }, { id: `${session.messages.length}-tutor`, role: 'tutor', text: response, createdAt });
  return response;
}

describe('authored sample lessons', () => {
  for (const topic of TOPICS) it(`${topic.id} has valid concepts, references and review cards`, () => {
    const lesson = createLesson({ id: 'session', topic: topic.id, mode: 'sample', now: new Date().toISOString(), messageId: 'hello' });
    expect(SessionSchema.safeParse(lesson).success).toBe(true);
    expect(lesson.flashcards.every(card => lesson.board.nodes.some(node => node.id === card.conceptId))).toBe(true);
    const selected = lesson.board.nodes[1]!;
    expect(sampleReply(lesson, 'Explain this', selected.id)).toContain(selected.detail);
    expect(summarizeSession(lesson)).toContain('not verified mastery');
    const visual = sampleTeachingReply(lesson, 'Show me a diagram');
    expect(visual.text).toContain('prepared sample diagram');
    expect(visual.beats?.[0]?.boardCommands.some(command => command.type === 'upsert_frame')).toBe(true);
    expect(visual.warnings ?? []).toEqual([]);
  });

  it('keeps the actual question through greetings, help and selected-object exploration', () => {
    const session = createLesson({ id: 's', topic: 'photosynthesis', mode: 'sample', now: new Date().toISOString(), messageId: 'hello' });
    const [carbon, energy, structure] = LESSONS.photosynthesis.questions;
    expect(respond(session, 'Hello')).toContain(carbon!.prompt);
    expect(respond(session, 'Help please')).toContain(carbon!.prompt);
    expect(respond(session, 'Explain this', 'chloroplast')).toContain(carbon!.prompt);
    const firstAnswer = respond(session, 'Carbon Dioxide');
    expect(firstAnswer).toContain('That matches the key idea.');
    expect(firstAnswer).toContain(energy!.prompt);
    expect(respond(session, 'Hello again')).toContain(energy!.prompt);
    expect(respond(session, 'What about this?', 'water')).toContain(energy!.prompt);
    expect(respond(session, 'sunlight')).toContain(structure!.prompt);
    expect(respond(session, 'Help')).toContain(structure!.prompt);
    expect(respond(session, 'chloroplasts')).toContain('That matches the key idea.');
  });

  it('does not advance for a wrong answer or accept a negated keyword', () => {
    const session = createLesson({ id: 's', topic: 'photosynthesis', mode: 'sample', now: new Date().toISOString(), messageId: 'hello' });
    for (const answer of ['oxygen', 'not carbon dioxide', 'It is not carbon dioxide']) {
      const response = respond(session, answer);
      expect(response).not.toContain('That matches the key idea.');
      expect(response).toContain(LESSONS.photosynthesis.questions[0]!.prompt);
    }
    expect(respond(session, 'Carbon dioxide')).toContain('That matches the key idea.');
  });
});
