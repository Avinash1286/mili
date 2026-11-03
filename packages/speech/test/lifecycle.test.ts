import { describe, expect, it } from 'vitest';
import { OutputEpoch } from '../src/epochs.js';
import { PlaybackTimingMap, type WordBoundaryFrame } from '../src/timing.js';

describe('output lifecycle', () => {
  it('invalidates the old epoch before synchronous abort callbacks and rejects late output', () => {
    const state = new OutputEpoch();
    expect(state.accepts(state.current)).toBe(false);
    const first = state.begin();
    let acceptedOnAbort: boolean | undefined;
    first.signal.addEventListener('abort', () => { acceptedOnAbort = state.accepts(first.epoch); });
    state.interrupt();
    expect(first.signal.aborted).toBe(true);
    expect(acceptedOnAbort).toBe(false);
    expect(state.accepts(first.epoch)).toBe(false);
    expect(state.accepts(state.current)).toBe(false);
    const next = state.begin();
    expect(state.accepts(next.epoch)).toBe(true);
    expect(next.signal.aborted).toBe(false);
    state.close();
    state.close();
    expect(state.accepts(next.epoch)).toBe(false);
    expect(next.signal.aborted).toBe(true);
    expect(() => state.begin()).toThrow('closed');
  });
});

describe('provider-to-player timing', () => {
  const frame: WordBoundaryFrame = {
    flush_id: 4, audio_start_ms: 9_000,
    words: [{ word: 'Hello', start: 9_100, end: 9_400, confidence: 0.9 }],
  };

  it('subtracts discarded provider audio and anchors each request independently', () => {
    const map = new PlaybackTimingMap();
    // Provider sent 9000 ms including cancelled audio, while browser clock is 42 s.
    map.register({ connectionId: 'socket-a', flushId: 4, epoch: 3, playbackStartSeconds: 42 });
    expect(map.map('socket-a', frame, 3)).toEqual([
      { word: 'Hello', confidence: 0.9, startSeconds: 42.1, endSeconds: 42.4 },
    ]);
    expect(map.map('socket-a', frame, 4)).toEqual([]);
    map.invalidateBefore(4);
    expect(map.map('socket-a', frame, 3)).toEqual([]);
  });

  it('does not confuse repeated flush IDs after socket rotation or out-of-order events', () => {
    const map = new PlaybackTimingMap();
    map.register({ connectionId: 'old', flushId: 4, epoch: 1, playbackStartSeconds: 10 });
    map.register({ connectionId: 'new', flushId: 4, epoch: 2, playbackStartSeconds: 20 });
    expect(map.map('new', frame, 2)[0]?.startSeconds).toBe(20.1);
    expect(map.map('old', frame, 2)).toEqual([]);
    map.forgetConnection('old');
    expect(map.map('old', frame, 1)).toEqual([]);
    expect(() => map.register({ connectionId: 'new', flushId: 4, epoch: 2, playbackStartSeconds: 22 }))
      .toThrow('different playback anchor');
  });

  it('ignores zero-length, low-confidence and invalid offsets, and bounds stored anchors', () => {
    const map = new PlaybackTimingMap(1);
    map.register({ connectionId: 'a', flushId: 3, epoch: 1, playbackStartSeconds: 2 });
    map.register({ connectionId: 'a', flushId: 4, epoch: 1, playbackStartSeconds: 3 });
    expect(map.map('a', { ...frame, flush_id: 3 }, 1)).toEqual([]);
    expect(map.map('a', { ...frame, words: [
      { word: '?', start: 9_100, end: 9_100, confidence: 0 },
      { word: 'bad', start: 8_900, end: 9_200, confidence: 0.8 },
      { word: 'bad', start: 9_100, end: 9_200, confidence: Number.NaN },
      ...frame.words,
    ] }, 1)).toHaveLength(1);
  });
});
