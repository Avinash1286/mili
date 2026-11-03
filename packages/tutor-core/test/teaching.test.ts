import { describe, expect, it } from 'vitest';
import { splitTeachingText } from '../src/index.js';

describe('bounded teaching text splitting', () => {
  it('does not choose an early sentence boundary that leaves more than one beat', () => {
    const text = 'A '.repeat(125) + '.' + ' B'.repeat(400);
    const beats = splitTeachingText(text);
    expect(beats).toHaveLength(2);
    expect(beats.every(beat => beat.length <= 600)).toBe(true);
    expect(beats.join(' ')).toBe(text);
  });
  it('preserves the complete content for every valid boundary length', () => {
    for (const length of [599, 600, 601, 1199, 1200]) {
      for (const text of ['x'.repeat(length), 'word '.repeat(240).slice(0, length), 'idea\n'.repeat(240).slice(0, length)]) {
        const beats = splitTeachingText(text);
        expect(beats.length).toBeLessThanOrEqual(2);
        expect(beats.every(beat => beat.length > 0 && beat.length <= 600)).toBe(true);
        expect(beats.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
      }
    }
  });
  it('uses a fitting sentence boundary and accounts for surrounding whitespace', () => {
    const first = 'A'.repeat(549) + '.', second = 'B'.repeat(599);
    expect(splitTeachingText(`  ${first}\n\t${second}  `)).toEqual([first, second]);
    expect(splitTeachingText(' \n ')).toEqual([]);
    expect(() => splitTeachingText('x'.repeat(1201))).toThrow('too long');
  });
});
