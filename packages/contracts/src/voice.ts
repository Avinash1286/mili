import { z } from 'zod';
import { SpatialSelectionSchema } from './spatial';
import { SessionSchema, BoardSchema, ConceptMapSchema, SelectionContextSchema, BoardTransactionSchema } from './index';

export const VOICE_PROTOCOL_VERSION = 1;
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const AUDIO_HEADER_BYTES = 28;
export const MAX_AUDIO_SAMPLES = 16000;

export const VoiceTicketSchema = z.object({ ticket: z.string().min(20), expiresAt: z.string().datetime() });
export type VoiceTicket = z.infer<typeof VoiceTicketSchema>;
export const VoiceStateSchema = z.enum(['idle', 'connecting', 'listening', 'recognizing', 'thinking', 'speaking', 'interrupted', 'reconnecting', 'paused', 'error', 'ended']);
export type VoiceState = z.infer<typeof VoiceStateSchema>;
const requestId = z.string().min(1).max(100);
const uint = z.number().int().min(0).max(0xffffffff);
const selection = z.string().min(1).max(100).optional();
export const VoiceClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input.text'), requestId, text: z.string().trim().min(1).max(2000), selectedNodeId: selection, selection: z.lazy(() => SelectionContextSchema).optional() }),
  z.object({ type: z.literal('input.audio.start'), streamId: uint }),
  z.object({ type: z.literal('input.audio.end') }),
  z.object({ type: z.literal('input.interrupt'), outputEpoch: uint, reason: z.enum(['control', 'speech', 'typing']).default('control') }),
  z.object({ type: z.literal('input.repeat'), messageId: requestId }),
  z.object({ type: z.literal('selection.update'), selectedNodeId: selection, selection: z.lazy(() => SelectionContextSchema).optional() }),
  z.object({ type: z.literal('board.operation'), transaction: z.lazy(() => BoardTransactionSchema) }),
  z.object({ type: z.literal('board.ready'), beatId: requestId, boardRevision: uint, outputEpoch: uint, ready: z.boolean().default(true) }),
  z.object({ type: z.literal('playback.ack'), outputEpoch: uint, streamId: uint, playedSamples: uint, status: z.enum(['started', 'progress', 'completed', 'interrupted', 'underrun']) }),
  z.object({ type: z.literal('session.pause') }),
  z.object({ type: z.literal('session.resume') }),
  z.object({ type: z.literal('session.close') }),
  z.object({ type: z.literal('heartbeat') })
]);
export type VoiceClientEvent = z.infer<typeof VoiceClientEventSchema>;

const envelope = { protocolVersion: z.literal(1), connectionId: z.string(), sessionId: z.string(), seq: uint, outputEpoch: uint };
export const VoiceServerEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('session.ready'), session: z.lazy(() => SessionSchema), inputSampleRate: z.literal(16000), outputSampleRate: z.literal(24000) }),
  z.object({ ...envelope, type: z.literal('session.snapshot'), session: z.lazy(() => SessionSchema) }),
  z.object({ ...envelope, type: z.literal('session.state'), state: VoiceStateSchema }),
  z.object({ ...envelope, type: z.literal('input.ready'), streamId: uint }),
  z.object({ ...envelope, type: z.literal('transcript.partial'), turnId: z.string(), text: z.string().max(12000) }),
  z.object({ ...envelope, type: z.literal('transcript.final'), turnId: z.string(), text: z.string().max(12000) }),
  z.object({ ...envelope, type: z.literal('tutor.beat'), turnId: z.string(), messageId: z.string(), beatId: z.string().optional(), text: z.string().max(12000), spokenText: z.string().max(1200).optional(), conceptIds: z.array(z.string()).max(24).optional(), highlightNodeIds: z.array(z.string()).max(40).optional() }),
  z.object({ ...envelope, type: z.literal('board.patch'), beatId: z.string().optional(), operationId: z.string(), board: z.lazy(() => BoardSchema), map: z.lazy(() => ConceptMapSchema).optional(), spatialState: SpatialSelectionSchema.optional(), visualSurface: z.enum(['board', 'spatial']).optional() }),
  z.object({ ...envelope, type: z.literal('map.patch'), map: z.lazy(() => ConceptMapSchema) }),
  z.object({ ...envelope, type: z.literal('audio.start'), streamId: uint, turnId: z.string(), messageId: z.string(), beatId: z.string().optional(), visualReady: z.boolean().default(true), sampleRate: z.literal(24000) }),
  z.object({ ...envelope, type: z.literal('audio.end'), streamId: uint }),
  z.object({ ...envelope, type: z.literal('audio.cancel'), reason: z.string().max(200) }),
  z.object({ ...envelope, type: z.literal('voice.metrics'), turnId: z.string(), llmMs: z.number().nonnegative(), firstAudioMs: z.number().nonnegative().optional(), inputAudioMs: z.number().nonnegative(), outputAudioMs: z.number().nonnegative() }),
  z.object({ ...envelope, type: z.literal('error'), code: z.string(), message: z.string().max(1000), recoverable: z.boolean(), operationId: z.string().optional() }),
  z.object({ ...envelope, type: z.literal('heartbeat') })
]);
export type VoiceServerEvent = z.infer<typeof VoiceServerEventSchema>;

export type AudioFrame = {
  kind: 'input' | 'output'; streamId: number; outputEpoch: number; seq: number;
  sampleRate: number; samples: Int16Array;
};

// All header fields are little endian. PCM payload is mono signed 16-bit LE.
// TOK1 | version:u8 | kind:u8 | encoding:u8 | channels:u8 |
// streamId:u32 | outputEpoch:u32 | seq:u32 | sampleRate:u32 | sampleCount:u32.
export function encodeAudioFrame(frame: AudioFrame): Uint8Array {
  if (!['input', 'output'].includes(frame.kind) || ![frame.streamId, frame.outputEpoch, frame.seq].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw new Error('Invalid audio frame metadata');
  if (frame.sampleRate !== (frame.kind === 'input' ? INPUT_SAMPLE_RATE : OUTPUT_SAMPLE_RATE)) throw new Error('Invalid audio sample rate');
  if (!frame.samples.length || frame.samples.length > MAX_AUDIO_SAMPLES) throw new Error('Invalid audio frame length');
  const buffer = new ArrayBuffer(AUDIO_HEADER_BYTES + frame.samples.length * 2);
  const view = new DataView(buffer);
  view.setUint32(0, 0x314b4f54, true); view.setUint8(4, 1); view.setUint8(5, frame.kind === 'input' ? 1 : 2); view.setUint8(6, 1); view.setUint8(7, 1);
  [frame.streamId, frame.outputEpoch, frame.seq, frame.sampleRate, frame.samples.length].forEach((value, i) => view.setUint32(8 + i * 4, value, true));
  frame.samples.forEach((value, i) => view.setInt16(AUDIO_HEADER_BYTES + i * 2, value, true));
  return new Uint8Array(buffer);
}

export function decodeAudioFrame(bytes: Uint8Array): AudioFrame {
  if (bytes.byteLength < AUDIO_HEADER_BYTES || bytes.byteLength > AUDIO_HEADER_BYTES + MAX_AUDIO_SAMPLES * 2) throw new Error('Invalid audio frame size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x314b4f54 || view.getUint8(4) !== 1 || ![1, 2].includes(view.getUint8(5)) || view.getUint8(6) !== 1 || view.getUint8(7) !== 1) throw new Error('Unsupported audio frame');
  const kind = view.getUint8(5) === 1 ? 'input' : 'output';
  const sampleRate = view.getUint32(20, true), count = view.getUint32(24, true);
  if (sampleRate !== (kind === 'input' ? INPUT_SAMPLE_RATE : OUTPUT_SAMPLE_RATE) || !count || count > MAX_AUDIO_SAMPLES || AUDIO_HEADER_BYTES + count * 2 !== bytes.byteLength) throw new Error('Invalid PCM payload');
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(AUDIO_HEADER_BYTES + i * 2, true);
  return { kind, streamId: view.getUint32(8, true), outputEpoch: view.getUint32(12, true), seq: view.getUint32(16, true), sampleRate, samples };
}
