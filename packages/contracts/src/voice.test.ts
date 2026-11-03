import { describe, expect, it } from 'vitest';
import { decodeAudioFrame, encodeAudioFrame, VoiceClientEventSchema, VoiceServerEventSchema, CapabilitiesSchema, type AudioFrame } from './index';

describe('voice protocol trust boundaries', () => {
  const frame: AudioFrame = { kind: 'input', streamId: 1, outputEpoch: 0, seq: 3, sampleRate: 16000, samples: new Int16Array([-32768, 0, 32767]) };
  it('round-trips signed little-endian PCM through offset views', () => {
    const bytes = encodeAudioFrame(frame);
    const packet = new Uint8Array(bytes.length + 4); packet.set(bytes, 2);
    expect(decodeAudioFrame(packet.subarray(2, 2 + bytes.length))).toEqual(frame);
    expect(Array.from(bytes.slice(28))).toEqual([0, 128, 0, 0, 255, 127]);
  });
  it('rejects truncated, oversized, unsupported and mislabeled audio', () => {
    expect(() => decodeAudioFrame(new Uint8Array(27))).toThrow();
    expect(() => decodeAudioFrame(new Uint8Array(32029))).toThrow();
    for (const [offset, value] of [[0, 0], [4, 2], [5, 3], [6, 2], [7, 2], [20, 0], [24, 255]]) {
      const bytes = encodeAudioFrame(frame); bytes[offset!] = value!;
      expect(() => decodeAudioFrame(bytes)).toThrow();
    }
    expect(() => decodeAudioFrame(encodeAudioFrame(frame).subarray(0, 30))).toThrow();
    expect(() => encodeAudioFrame({ ...frame, sampleRate: 48000 })).toThrow();
    expect(() => encodeAudioFrame({ ...frame, seq: -1 })).toThrow();
    expect(() => encodeAudioFrame({ ...frame, samples: new Int16Array(0) })).toThrow();
  });
  it('requires request identity and bounds client controls', () => {
    expect(VoiceClientEventSchema.safeParse({ type: 'input.text', text: 'Hello' }).success).toBe(false);
    expect(VoiceClientEventSchema.safeParse({ type: 'input.text', requestId: 'turn-1', text: 'x'.repeat(2001) }).success).toBe(false);
    expect(VoiceClientEventSchema.parse({ type: 'input.text', requestId: 'turn-1', text: ' Hello ' }).type).toBe('input.text');
    expect(VoiceClientEventSchema.safeParse({ type: 'playback.ack', outputEpoch: 1, streamId: 1, playedSamples: -1, status: 'completed' }).success).toBe(false);
  });
  it('requires version, session, sequence and epoch for server controls', () => {
    const event = { protocolVersion: 1, connectionId: 'c1', sessionId: 's1', seq: 1, outputEpoch: 2, type: 'audio.start', streamId: 1, turnId: 't1', messageId: 'm1', sampleRate: 24000 };
    expect(VoiceServerEventSchema.parse(event)).toEqual({ ...event, visualReady: true });
    expect(VoiceServerEventSchema.parse({ ...event, beatId: 'beat-1', visualReady: false })).toMatchObject({ beatId: 'beat-1', visualReady: false });
    expect(VoiceClientEventSchema.safeParse({ type: 'board.ready', beatId: 'beat-1', outputEpoch: 1 }).success).toBe(false);
    expect(VoiceClientEventSchema.parse({ type: 'board.ready', beatId: 'beat-1', outputEpoch: 1, boardRevision: 2 })).toMatchObject({ ready: true });
    expect(VoiceServerEventSchema.safeParse({ ...event, sampleRate: 16000 }).success).toBe(false);
    expect(VoiceServerEventSchema.safeParse({ ...event, outputEpoch: -1 }).success).toBe(false);
    expect(VoiceServerEventSchema.safeParse({ ...event, protocolVersion: 2 }).success).toBe(false);
    expect(CapabilitiesSchema.parse({ tutor: false, speech: false })).toEqual({ tutor: false, speech: false, voice: false });
  });
});
