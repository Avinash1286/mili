import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAudioFrame, type Session } from '@milli/contracts';
import { api, RequestError } from '../src/lib/api';
import { VoiceRuntime } from '../src/lib/voice-runtime';

const session: Session = {
  id: 'lesson-1', topic: 'photosynthesis', title: 'Plants', mode: 'live', status: 'active',
  createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', revision: 0,
  messages: [], board: { nodes: [], edges: [] }, concepts: [], flashcards: []
};
const ticket = { ticket: 'a-valid-single-use-ticket-for-tests', expiresAt: '2026-11-03T01:00:00.000Z' };
let failCapture = false;
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close = vi.fn();
  postMessage = vi.fn((data: { type: string }) => { if (data.type === 'flush') this.emit({ type: 'pcm', samples: new Int16Array(80), rms: .1, final: true }); });
  emit(data: unknown) { this.onmessage?.({ data }); }
}
class FakeWorklet {
  static instances: FakeWorklet[] = [];
  port = new FakePort(); connect = vi.fn(); disconnect = vi.fn(); onprocessorerror?: () => void;
  constructor(_context: unknown, readonly name: string) {
    if (failCapture && name === 'tokai-capture') throw new Error('Capture construction failed');
    FakeWorklet.instances.push(this);
  }
}
class FakeContext {
  static instances: FakeContext[] = [];
  state = 'running'; destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  constructor() { FakeContext.instances.push(this); }
}
class FakeSocket {
  static OPEN = 1; static instances: FakeSocket[] = [];
  readyState = 1; bufferedAmount = 0; binaryType = '';
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  onclose?: (event?: { code: number; reason: string }) => void; onerror?: () => void;
  send = vi.fn(); close = vi.fn(() => { this.readyState = 3; });
  sequence = 0;
  constructor(_url: string) { FakeSocket.instances.push(this); }
  event(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ protocolVersion: 1, connectionId: 'connection-1', sessionId: session.id, seq: this.sequence++, outputEpoch: 10, ...event }) });
  }
  controls() { return this.send.mock.calls.flatMap(([frame]) => typeof frame === 'string' ? [JSON.parse(frame)] : []); }
  audio() { return this.send.mock.calls.flatMap(([frame]) => typeof frame !== 'string' ? [decodeAudioFrame(frame)] : []); }
}
let runtime: VoiceRuntime;
let track: { stop: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;
function ready(socket = FakeSocket.instances.at(-1)!) {
  socket.event({ type: 'session.ready', session, inputSampleRate: 16000, outputSampleRate: 24000 });
  return socket;
}
function capture() { return FakeWorklet.instances.find(node => node.name === 'tokai-capture')!; }
function micPacket() { capture().port.emit({ type: 'pcm', samples: new Int16Array(800).fill(2000), rms: .1, final: false }); }

beforeEach(() => {
  vi.useFakeTimers(); failCapture = false;
  FakeSocket.instances = []; FakeWorklet.instances = []; FakeContext.instances = [];
  track = { stop: vi.fn(), addEventListener: vi.fn() };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  vi.stubGlobal('window', { isSecureContext: true, AudioContext: FakeContext, location: { origin: 'https://tokai.example.test' } });
  vi.stubGlobal('AudioContext', FakeContext); vi.stubGlobal('AudioWorkletNode', FakeWorklet); vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) } });
  vi.spyOn(api, 'voiceTicket').mockResolvedValue(ticket);
  runtime = new VoiceRuntime(session.id);
});
afterEach(() => { runtime.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('browser voice lifecycle', () => {
  it('rotates a planned connection without re-requesting microphone permission or replaying audio', async () => {
    await runtime.start(true); const socket = ready();
    runtime.handsFree(true);
    socket.onclose?.({ code: 1012, reason: 'Voice connection rotating' });
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2); expect(getUserMedia).toHaveBeenCalledTimes(1); expect(FakeContext.instances).toHaveLength(1);
    expect(runtime.getSnapshot()).toMatchObject({ connected: false, state: 'reconnecting', handsFree: false, microphone: true });
    const next = ready(); expect(runtime.getSnapshot().connected).toBe(true); expect(next.audio()).toHaveLength(0);
    expect(FakeWorklet.instances[0].port.postMessage).toHaveBeenCalledWith({ type: 'clear', epoch: 0 });
    runtime.beginTalking(); expect(next.controls().at(-1)).toMatchObject({ type: 'input.audio.start' });
  });
  it('cancels planned reconnection when the page is hidden', async () => {
    await runtime.start(false); const socket = ready();
    vi.mocked(api.voiceTicket).mockImplementationOnce(() => new Promise(() => {}));
    socket.onclose?.({ code: 1012, reason: 'Voice connection rotating' });
    runtime.pauseForVisibility(); await vi.advanceTimersByTimeAsync(1);
    expect(runtime.getSnapshot()).toMatchObject({ state: 'paused', connected: false }); expect(FakeContext.instances[0].close).toHaveBeenCalled();
  });
  it('keeps output-only conversation available after microphone permission denial', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await runtime.start(true); ready();
    expect(runtime.getSnapshot()).toMatchObject({ connected: true, microphone: false });
    expect(runtime.getSnapshot().notice).toContain('permission was denied');
    expect(runtime.text('Explain sunlight')).toBe(true);
    expect(FakeSocket.instances[0].controls().at(-1).type).toBe('input.text');
  });
  it('stops acquired tracks if microphone processor setup fails', async () => {
    failCapture = true;
    await runtime.start(true); ready();
    expect(track.stop).toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({ connected: true, microphone: false });
    expect(runtime.getSnapshot().notice).toContain('Voice output still works');
  });
  it('buffers short speech until the matching input.ready and sends its endpoint after all PCM', async () => {
    await runtime.start(true); const socket = ready();
    runtime.beginTalking(); micPacket(); runtime.endTalking();
    const start = socket.controls().find(event => event.type === 'input.audio.start');
    expect(start.streamId).toBeGreaterThan(0);
    expect(socket.audio()).toHaveLength(0);
    expect(socket.controls().some(event => event.type === 'input.audio.end')).toBe(false);
    socket.event({ type: 'input.ready', streamId: start.streamId + 1 });
    expect(socket.audio()).toHaveLength(0);
    socket.event({ type: 'input.ready', streamId: start.streamId });
    expect(socket.audio().map(frame => ({ rate: frame.sampleRate, count: frame.samples.length, seq: frame.seq }))).toEqual([
      { rate: 16000, count: 800, seq: 0 }, { rate: 16000, count: 80, seq: 1 }
    ]);
    expect(socket.controls().at(-1).type).toBe('input.audio.end');
    expect(runtime.getSnapshot().recording).toBe(false);
  });
  it('typing replaces an in-progress mic turn without endpointing or releasing stale audio', async () => {
    await runtime.start(true); const socket = ready();
    runtime.beginTalking(); micPacket();
    const start = socket.controls().find(event => event.type === 'input.audio.start');
    runtime.text('Use this typed question instead');
    expect(socket.controls().filter(event => event.type === 'input.audio.end')).toHaveLength(0);
    expect(socket.controls().filter(event => event.type === 'input.text')).toHaveLength(1);
    socket.event({ type: 'input.ready', streamId: start.streamId });
    expect(socket.audio()).toHaveLength(0);
    expect(runtime.getSnapshot()).toMatchObject({ recording: false, state: 'thinking' });
  });
  it('stops a stalled transcriber before buffered microphone audio exceeds two seconds', async () => {
    await runtime.start(true); ready(); runtime.beginTalking();
    for (let i = 0; i < 41; i++) micPacket();
    expect(runtime.getSnapshot()).toMatchObject({ state: 'error', connected: false, microphone: false });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeSocket.instances[0].audio()).toHaveLength(0);
  });
  it('pauses hidden pages by releasing tracks, processors, sockets and timers', async () => {
    await runtime.start(true); const socket = ready(); runtime.beginTalking();
    runtime.pauseForVisibility();
    expect(runtime.getSnapshot()).toMatchObject({ state: 'paused', connected: false, microphone: false });
    expect(track.stop).toHaveBeenCalled(); expect(socket.close).toHaveBeenCalled();
    expect(FakeContext.instances[0].close).toHaveBeenCalled();
    for (const node of FakeWorklet.instances) { expect(node.port.close).toHaveBeenCalled(); expect(node.disconnect).toHaveBeenCalled(); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases microphone permission that resolves after the user cancels connection', async () => {
    let allow!: (value: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { allow = resolve; }));
    const starting = runtime.start(true);
    await vi.advanceTimersByTimeAsync(0);
    runtime.stop(); allow({ getTracks: () => [track], getAudioTracks: () => [track] }); await starting;
    expect(track.stop).toHaveBeenCalled(); expect(FakeSocket.instances).toHaveLength(0);
    expect(runtime.getSnapshot().connected).toBe(false);
  });
  it('briefly retries only this runtime’s just-closed ownership conflict', async () => {
    await runtime.start(false); ready(); runtime.stop();
    vi.mocked(api.voiceTicket).mockRejectedValueOnce(new RequestError('Finishing close', 409, 'VOICE_ACTIVE'));
    const starting = runtime.start(false);
    await vi.advanceTimersByTimeAsync(200); await starting;
    expect(api.voiceTicket).toHaveBeenCalledTimes(3);
    expect(FakeSocket.instances).toHaveLength(2);
    ready(); expect(runtime.getSnapshot().connected).toBe(true);
  });
  it('does not retry or take over another tab’s active voice session', async () => {
    vi.mocked(api.voiceTicket).mockRejectedValue(new RequestError('Another tab is active', 409, 'VOICE_ACTIVE'));
    await runtime.start(false);
    expect(api.voiceTicket).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toMatchObject({ state: 'error', connected: false });
    expect(FakeSocket.instances).toHaveLength(0);
  });
  it('acknowledges board readiness only after rendering and then releases the corresponding beat', async () => {
    let finishRender!: (ready: boolean) => void;
    runtime.onBoard = vi.fn(() => new Promise<boolean>(resolve => { finishRender = resolve; }));
    await runtime.start(false); const socket = ready();
    socket.event({ type: 'tutor.beat', beatId: 'beat-1', turnId: 'turn-1', messageId: 'message-1', text: 'Watch this idea', highlightNodeIds: ['a'] });
    socket.event({ type: 'board.patch', operationId: 'visual-1', beatId: 'beat-1', board: { ...session.board, revision: 1, nodes: [{ id: 'a', label: 'Focus here', detail: '', kind: 'concept', x: 1140, y: 80 }] } });
    socket.event({ type: 'audio.start', beatId: 'beat-1', turnId: 'turn-1', messageId: 'message-1', streamId: 7, sampleRate: 24000, visualReady: true });
    const playback = FakeWorklet.instances.find(node => node.name === 'tokai-playback')!;
    expect(socket.controls().some(event => event.type === 'board.ready')).toBe(false);
    expect(runtime.onBoard).toHaveBeenCalledWith(expect.any(Object), 'beat-1', expect.any(AbortSignal), undefined, ['a'], undefined, undefined);
    expect(playback.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', ready: false, streamId: 7 }));
    finishRender(true); await vi.advanceTimersByTimeAsync(0);
    expect(socket.controls()).toContainEqual({ type: 'board.ready', beatId: 'beat-1', boardRevision: 1, outputEpoch: 10, ready: true });
    expect(playback.port.postMessage).toHaveBeenCalledWith({ type: 'release', epoch: 10, streamId: 7 });
  });
  it('retains the model for map-only beats and applies surface snapshots only after readiness', async () => {
    const sessions: Session[] = []; runtime.onSession = value => sessions.push(value);
    let finishRender!: (ready: boolean) => void;
    runtime.onBoard = vi.fn(() => new Promise<boolean>(resolve => { finishRender = resolve; }));
    await runtime.start(false); const socket = ready();
    const spatialState = { modelId: 'dna' as const, assetVersion: '1.0.0', partIds: ['base-pair'] };
    socket.event({ type: 'board.patch', operationId: 'model', beatId: 'model-beat', board: session.board, spatialState, visualSurface: 'spatial' });
    socket.event({ type: 'session.snapshot', session: { ...session, spatialState, visualSurface: 'spatial' } });
    expect(sessions.at(-1)?.spatialState).toBeUndefined();
    expect(sessions.at(-1)?.visualSurface).toBeUndefined();
    finishRender(true); await vi.advanceTimersByTimeAsync(0);
    socket.event({ type: 'board.patch', operationId: 'map-only', beatId: 'map-beat', board: session.board, visualSurface: 'spatial' });
    expect(runtime.onBoard).toHaveBeenLastCalledWith(expect.any(Object), 'map-beat', expect.any(AbortSignal), undefined, [], undefined, 'spatial');
    finishRender(true); await vi.advanceTimersByTimeAsync(0);
    socket.event({ type: 'session.snapshot', session: { ...session, spatialState, visualSurface: 'spatial' } });
    expect(sessions.at(-1)?.spatialState).toEqual(spatialState);
    expect(sessions.at(-1)?.visualSurface).toBe('spatial');
    socket.event({ type: 'board.patch', operationId: 'diagram', beatId: 'diagram-beat', board: session.board, visualSurface: 'board' });
    finishRender(true); await vi.advanceTimersByTimeAsync(0);
    socket.event({ type: 'session.snapshot', session: { ...session, spatialState, visualSurface: 'board' } });
    expect(sessions.at(-1)?.visualSurface).toBe('board');
    expect(sessions.at(-1)?.spatialState).toEqual(spatialState);
  });
  it('never releases a stale visual prepare after interruption', async () => {
    let finishRender!: (ready: boolean) => void;
    runtime.onBoard = () => new Promise(resolve => { finishRender = resolve; });
    await runtime.start(false); const socket = ready();
    socket.event({ type: 'board.patch', operationId: 'visual-old', beatId: 'beat-old', board: { ...session.board, revision: 1 } });
    runtime.interrupt(); socket.event({ type: 'audio.cancel', outputEpoch: 11, reason: 'Student interrupted' });
    finishRender(true); await vi.advanceTimersByTimeAsync(0);
    expect(socket.controls().some(event => event.type === 'board.ready')).toBe(false);
  });
  it('rejects a scoped board conflict without disrupting microphone or voice', async () => {
    await runtime.start(true); const socket = ready();
    const saving = runtime.boardOperation({ operationId: 'save-1', expectedRevision: 0, commands: [{ type: 'upsert_node', node: { id: 'a', label: 'My idea', detail: '', kind: 'concept', x: 0, y: 0 } }] });
    const rejection = expect(saving).rejects.toMatchObject({ status: 409, code: 'BOARD_CONFLICT' });
    socket.event({ type: 'error', code: 'BOARD_CONFLICT', operationId: 'save-1', message: 'The board changed', recoverable: true });
    await rejection;
    expect(runtime.getSnapshot()).toMatchObject({ connected: true, microphone: true, state: 'listening' });
  });
  it('history snapshots cannot bypass a pending visual prepare and interruption blocks late patches', async () => {
    const sessions: Session[] = []; runtime.onSession = value => sessions.push(value);
    let pendingSignal: AbortSignal | undefined;
    runtime.onBoard = vi.fn((_board, _beatId, signal) => { pendingSignal = signal; return new Promise<boolean>(resolve => signal?.addEventListener('abort', () => resolve(false), { once: true })); });
    runtime.onMap = vi.fn();
    await runtime.start(false); const socket = ready();
    const changed = { ...session.board, revision: 1, nodes: [{ id: 'future', label: 'Pending visual', detail: '', kind: 'concept', x: 0, y: 0 }] };
    socket.event({ type: 'session.snapshot', session: { ...session, revision: 1, board: changed } });
    expect(sessions.at(-1)?.board.nodes).toHaveLength(0);
    socket.event({ type: 'board.patch', operationId: 'visual-1', beatId: 'beat-1', board: changed });
    runtime.interrupt();
    expect(pendingSignal?.aborted).toBe(true);
    socket.event({ type: 'board.patch', operationId: 'visual-late', beatId: 'beat-late', board: changed });
    socket.event({ type: 'map.patch', map: { topicId: 'photosynthesis', revision: 1, nodes: [], edges: [] } });
    socket.event({ type: 'session.snapshot', session: { ...session, revision: 2, board: changed } });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.onBoard).toHaveBeenCalledTimes(1); expect(runtime.onMap).not.toHaveBeenCalled();
    expect(sessions.at(-1)?.board.nodes).toHaveLength(0);
    expect(socket.controls().some(event => event.type === 'board.ready')).toBe(false);
  });
});
