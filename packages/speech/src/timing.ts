export interface WordBoundaryFrame {
  flush_id: number;
  audio_start_ms: number;
  words: { word: string; start: number; end: number; confidence: number }[];
}
export interface PlaybackAnchor {
  connectionId: string;
  flushId: number;
  epoch: number;
  playbackStartSeconds: number;
}
export interface TimedWord {
  word: string;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
}

/** Uses request-local offsets, including after discarded/cancelled provider audio. */
export class PlaybackTimingMap {
  #anchors = new Map<string, PlaybackAnchor>();
  constructor(private readonly maxAnchors = 128) {
    if (!Number.isSafeInteger(maxAnchors) || maxAnchors < 1 || maxAnchors > 4_096) {
      throw new Error('Timing anchor capacity must be between 1 and 4096.');
    }
  }

  register(anchor: PlaybackAnchor): void {
    if (!anchor.connectionId || !Number.isSafeInteger(anchor.flushId) || anchor.flushId < 0
        || !Number.isSafeInteger(anchor.epoch) || anchor.epoch < 0
        || !Number.isFinite(anchor.playbackStartSeconds) || anchor.playbackStartSeconds < 0) {
      throw new Error('Invalid playback anchor.');
    }
    const key = this.#key(anchor.connectionId, anchor.flushId);
    const prior = this.#anchors.get(key);
    if (prior && (prior.epoch !== anchor.epoch || prior.playbackStartSeconds !== anchor.playbackStartSeconds)) {
      throw new Error('A synthesis request already has a different playback anchor.');
    }
    this.#anchors.set(key, { ...anchor });
    if (this.#anchors.size > this.maxAnchors) this.#anchors.delete(this.#anchors.keys().next().value!);
  }

  map(connectionId: string, frame: WordBoundaryFrame, currentEpoch: number): TimedWord[] {
    const anchor = this.#anchors.get(this.#key(connectionId, frame.flush_id));
    if (!anchor || anchor.epoch !== currentEpoch || !Number.isSafeInteger(frame.audio_start_ms)
        || frame.audio_start_ms < 0) return [];
    return frame.words.flatMap(({ word, start, end, confidence }) => {
      if (!word || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start < frame.audio_start_ms || end <= start || !Number.isFinite(confidence)
          || confidence <= 0 || confidence > 1) return [];
      return [{ word, confidence,
        startSeconds: anchor.playbackStartSeconds + (start - frame.audio_start_ms) / 1_000,
        endSeconds: anchor.playbackStartSeconds + (end - frame.audio_start_ms) / 1_000 }];
    });
  }

  invalidateBefore(epoch: number): void {
    for (const [key, anchor] of this.#anchors) if (anchor.epoch < epoch) this.#anchors.delete(key);
  }

  forgetConnection(connectionId: string): void {
    for (const [key, anchor] of this.#anchors) if (anchor.connectionId === connectionId) this.#anchors.delete(key);
  }

  #key(connectionId: string, flushId: number): string { return JSON.stringify([connectionId, flushId]); }
}
