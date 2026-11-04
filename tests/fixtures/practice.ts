import { TeachingBeatProposalSchema } from '../../packages/contracts/src/index.js';
import { getLessonPack } from '../../packages/learning/src/index.js';

export const PRACTICE_REQUEST = 'Give me the saved tutor practice question.';
const definition = getLessonPack('photosynthesis')!.assessments.find(item => item.kind === 'multiple-choice')!;
if (definition.grading.type !== 'choice') throw new Error('The authored practice fixture needs a choice definition.');
export const PRACTICE_CORRECT_LABELS = definition.options!.filter(option => definition.grading.type === 'choice' && definition.grading.correctOptionIds.includes(option.id)).map(option => option.label);

// These authored answer keys stay in Node-side fixtures, never the browser bundle.
export function practiceReply() {
  const beat = TeachingBeatProposalSchema.parse({
    spokenText: definition.prompt,
    displayText: definition.prompt,
    conceptIds: definition.conceptIds,
    learningAction: { type: 'ask_question', assessmentId: definition.id, assessmentVersion: definition.version },
  });
  return { text: beat.displayText, beats: [beat] };
}
