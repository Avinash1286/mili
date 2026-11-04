import { describe, expect, it } from 'vitest';
import { matchVoiceCommand } from '../src/voice-commands.js';

describe('spoken voice commands', () => {
  it.each([
    ['Show me the 3D model.', 'show-3d'], ['open 3-D', 'show-3d'], ['Milli, show me in 3D please', 'show-3d'],
    ['Hide the 3D model', 'hide-3d'], ['Open my concept map', 'open-concepts'], ['Show practice', 'open-practice'],
    ['Open the transcript.', 'open-conversation'], ['Finish the lesson', 'finish-lesson'], ['Can you repeat that?', 'repeat'],
    ['Say it again please', 'repeat'], ['Okay milli, end lesson', 'finish-lesson'],
  ] as const)('%s -> %s', (text, command) => { expect(matchVoiceCommand(text)).toBe(command); });
  it('leaves ordinary questions for the tutor', () => {
    for (const text of ['Why does the 3D model show two membranes?', 'Can you show me how practice problems work with fractions?', 'repeat the part about chlorophyll', 'I want to end the lesson after this question about light'])
      expect(matchVoiceCommand(text)).toBeUndefined();
  });
});
