import { decodeAudioFrame, encodeAudioFrame, VoiceServerEventSchema, type VoiceClientEvent, type VoiceState, type Session, type Board, type BoardTransaction, type ConceptMap, type SelectionContext, type SpatialSelection } from '@tokai/contracts';
import { api, errorText, RequestError, voiceSocketUrl } from './api';

export type VoiceView = {
  state: VoiceState; connected: boolean; microphone: boolean; recording: boolean; handsFree: boolean;
  partial: string; caption: string; messageId?: string; error: string; notice: string;
  devices: { id: string; label: string }[]; deviceId: string; level: number;
  metrics?: { llmMs: number; firstAudioMs?: number; inputAudioMs: number; outputAudioMs: number };
  audibleMs?: number;
  beatId?: string; highlightNodeIds: string[];
};
export const initialVoiceView: VoiceView = { state: 'idle', connected: false, microphone: false, recording: false, handsFree: false, partial: '', caption: '', error: '', notice: '', devices: [], deviceId: '', level: 0, highlightNodeIds: [] };
type OutputStream = { epoch: number; seq: number; played: number; messageId: string; beatId?: string; text?: string; highlightNodeIds?: string[]; visualReady?: boolean };

/** One owner for browser media, network and cancellation. No provider credentials. */
export class VoiceRuntime {
  private view: VoiceView = initialVoiceView;
  private listeners = new Set<() => void>();
  private socket?: WebSocket; private context?: AudioContext; private playback?: AudioWorkletNode;
  private capture?: AudioWorkletNode; private source?: MediaStreamAudioSourceNode; private media?: MediaStream;
  private generation = 0; private micGeneration = 0; private epoch = 0; private blockedEpoch = -1;
  private connectAbort?: AbortController; private ownCloseUntil = 0;
  private connectionId?: string; private lastServerSeq = -1; private streams = new Map<number, OutputStream>();
  private inputStream = 0; private inputSeq = 0; private talking = false; private ending = false;
  private inputReady = false; private inputPending: Int16Array[] = []; private inputPendingEnd = false;
  private heartbeat?: ReturnType<typeof setInterval>; private connectTimer?: ReturnType<typeof setTimeout>;
  private utteranceTimer?: ReturnType<typeof setTimeout>; private inputReadyTimer?: ReturnType<typeof setTimeout>; private speechFrames = 0; private silentFrames = 0;
  private preroll: Int16Array[] = []; private selectedNodeId?: string; private intentionalClose = false;
  private finalizedAt?: number;
  private selection?: SelectionContext;
  private beats = new Map<string, { text: string; messageId: string; highlightNodeIds: string[] }>();
  private readyBeats = new Set<string>();
  private displayedBoard?: Board; private displayedMap?: ConceptMap; private displayedSpatial?: SpatialSelection; private displayedSurface?: 'board' | 'spatial';
  private visualPrepares = new Map<string, AbortController>();
  private boardRequests = new Map<string, { resolve: (board: Board) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onSession: (session: Session) => void = () => {};
  onBoard: (board: Board, beatId?: string, signal?: AbortSignal, map?: ConceptMap, focusIds?: string[], spatialState?: SpatialSelection, visualSurface?: 'board' | 'spatial') => Promise<boolean> = async () => false;
  onMap: (map: ConceptMap) => void = () => {};
  constructor(private readonly sessionId: string) {}
  getSnapshot = () => this.view;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private update(patch: Partial<VoiceView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach(fn => fn()); }
  private send(event: VoiceClientEvent) { if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(event)); return true; } return false; }
  select(id?: string, selection?: SelectionContext) { this.selectedNodeId = id; this.selection = selection; if (this.view.connected) this.send({ type: 'selection.update', selectedNodeId: id, selection }); }
  boardOperation(transaction: BoardTransaction): Promise<Board> {
    if (!this.view.connected) return Promise.reject(new Error('Voice disconnected before the board could save.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.boardRequests.delete(transaction.operationId); reject(new Error('The board save was not acknowledged. Your edits are still here; reload the latest board before retrying.')); }, 10000);
      this.boardRequests.set(transaction.operationId, { resolve, reject, timer });
      if (!this.send({ type: 'board.operation', transaction })) { clearTimeout(timer); this.boardRequests.delete(transaction.operationId); reject(new Error('Voice disconnected before the board could save.')); }
    });
  }

  async start(microphone = true, deviceId = this.view.deviceId) {
    this.stop('idle'); const generation = ++this.generation;
    const connectAbort = new AbortController(); this.connectAbort = connectAbort;
    this.intentionalClose = false; this.epoch = 0; this.blockedEpoch = -1; this.lastServerSeq = -1; this.connectionId = undefined;
    this.update({ state: 'connecting', error: '', notice: '', partial: '', caption: '', messageId: undefined, deviceId, metrics: undefined, audibleMs: undefined });
    try {
      if (!window.isSecureContext || !window.AudioContext) throw new Error('Voice needs a secure browser context (HTTPS or localhost) with Web Audio. You can still type.');
      const context = new AudioContext({ latencyHint: 'interactive' }); this.context = context;
      // Called before any network await so the explicit click can unlock playback.
      await context.resume();
      if (context.state !== 'running') throw new Error('Your browser paused audio. Click Start voice again to allow playback.');
      await context.audioWorklet.addModule('/voice-worklets.js');
      if (generation !== this.generation) { await context.close().catch(() => {}); return; }
      const playback = new AudioWorkletNode(context, 'tokai-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      playback.port.onmessage = event => this.onPlayback(event.data); playback.connect(context.destination); this.playback = playback;
      playback.onprocessorerror = () => { if (generation === this.generation) this.fail('Audio playback stopped. Reconnect voice or keep typing.'); };
      if (microphone) {
        try { await this.enableMicrophone(deviceId); } catch (e) { if (generation !== this.generation) return; this.update({ notice: `${microphoneError(e)} Voice output still works with typed questions.`, microphone: false }); }
      }
      if (generation !== this.generation) return;
      const ticket = await this.ticketAfterOwnClose(connectAbort.signal);
      if (generation !== this.generation) return;
      const socket = new WebSocket(voiceSocketUrl(ticket.ticket)); socket.binaryType = 'arraybuffer'; this.socket = socket;
      this.connectTimer = setTimeout(() => { if (generation === this.generation && !this.view.connected) this.fail('The voice connection took too long. Retry, or continue typing.'); }, 15000);
      socket.onmessage = event => { if (generation !== this.generation) return; try { if (typeof event.data === 'string') this.receiveEvent(event.data); else if (event.data instanceof ArrayBuffer) this.receiveAudio(event.data); else throw new Error('Unsupported voice frame'); } catch { this.fail('The voice stream could not be read safely. Reconnect to continue.'); } };
      socket.onerror = () => { if (generation === this.generation) this.update({ error: 'The voice connection failed. Check the connection and retry.' }); };
      socket.onclose = () => { if (generation !== this.generation || this.intentionalClose) return; this.stop('reconnecting'); this.update({ notice: 'Voice disconnected. Reconnect to restore the latest lesson; old audio will not replay.' }); };
    } catch (e) { if (generation === this.generation) this.fail(errorText(e)); }
  }
  private async ticketAfterOwnClose(signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try { return await api.voiceTicket(this.sessionId, AbortSignal.any([signal, AbortSignal.timeout(10000)])); }
      catch (error) {
        // Only allow our just-closed connection time to finish its durable flush.
        // A different tab's ownership remains authoritative; this never takes it over.
        if (!(error instanceof RequestError) || error.status !== 409 || error.code !== 'VOICE_ACTIVE' || Date.now() > this.ownCloseUntil || attempt >= 2 || signal.aborted) throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 150 * (attempt + 1));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }
  async enableMicrophone(deviceId = '') {
    if (!this.context || this.context.state === 'closed') return;
    this.disableMicrophone(); const micGeneration = ++this.micGeneration, generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a microphone.');
    const media = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (micGeneration !== this.micGeneration || generation !== this.generation || !this.context || (this.context.state as AudioContextState) === 'closed') { media.getTracks().forEach(track => track.stop()); return; }
    try {
      this.media = media;
      const capture = new AudioWorkletNode(this.context, 'tokai-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.capture = capture; this.source = this.context.createMediaStreamSource(media); this.source.connect(capture); capture.connect(this.context.destination);
      capture.port.onmessage = ({ data }) => { if (generation === this.generation && micGeneration === this.micGeneration && data.type === 'pcm') this.onCapture(data.samples, data.rms, data.final); };
      capture.onprocessorerror = () => { if (generation === this.generation && micGeneration === this.micGeneration) { this.disableMicrophone(); this.update({ notice: 'The microphone processor stopped. Enable the microphone again or continue typing.' }); } };
      media.getAudioTracks()[0]?.addEventListener('ended', () => { if (micGeneration === this.micGeneration) { this.disableMicrophone(); this.update({ notice: 'The microphone disconnected. Choose another microphone or keep typing.' }); } });
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (micGeneration !== this.micGeneration || generation !== this.generation) return;
      this.update({ microphone: true, deviceId, devices: devices.filter(d => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })) });
    } catch (error) {
      media.getTracks().forEach(track => track.stop());
      if (generation === this.generation && micGeneration === this.micGeneration) this.disableMicrophone();
      throw error;
    }
  }
  disableMicrophone() {
    this.micGeneration++;
    this.abandonInput();
    this.media?.getTracks().forEach(track => track.stop()); this.media = undefined;
    this.source?.disconnect(); this.source = undefined;
    if (this.capture) { this.capture.port.onmessage = null; this.capture.port.close(); this.capture.disconnect(); this.capture = undefined; }
    this.preroll = []; this.speechFrames = 0; this.silentFrames = 0;
    this.update({ microphone: false, recording: false, handsFree: false, level: 0 });
  }
  async changeDevice(id: string) { try { await this.enableMicrophone(id); } catch (e) { this.update({ notice: microphoneError(e) }); } }
  handsFree(enabled: boolean) { if (!this.view.microphone) return; if (!enabled) this.endTalking(); this.speechFrames = 0; this.silentFrames = 0; this.preroll = []; this.update({ handsFree: enabled }); }
  beginTalking = () => {
    if (!this.view.connected || !this.view.microphone || this.talking || this.ending || this.inputPendingEnd) return;
    this.interrupt('speech'); this.inputStream++; this.inputSeq = 0; this.talking = true; this.ending = false;
    this.inputReady = false; this.inputPending = []; this.inputPendingEnd = false;
    this.capture?.port.postMessage({ type: 'reset' });
    this.send({ type: 'input.audio.start', streamId: this.inputStream }); this.update({ recording: true, partial: '', state: 'connecting' });
    this.inputReadyTimer = setTimeout(() => this.fail('Speech recognition did not become ready. Your microphone stopped; retry or type your question.'), 8000);
    this.utteranceTimer = setTimeout(() => this.endTalking(), 30000);
  };
  endTalking = () => { if (!this.talking || this.ending) return; this.ending = true; clearTimeout(this.utteranceTimer); if (this.capture) this.capture.port.postMessage({ type: 'flush' }); else this.finishInput(); };
  private finishInput() { if (this.talking || this.ending) { if (this.inputReady) this.send({ type: 'input.audio.end' }); else this.inputPendingEnd = true; } this.talking = false; this.ending = false; this.preroll = []; this.speechFrames = 0; this.silentFrames = 0; this.update({ recording: false, state: this.view.connected ? 'recognizing' : this.view.state }); }
  private abandonInput(endpoint = true) {
    if (endpoint && (this.talking || this.ending || this.inputPendingEnd)) this.send({ type: 'input.audio.end' });
    this.talking = false; this.ending = false; this.inputReady = false; this.inputPending = []; this.inputPendingEnd = false;
    clearTimeout(this.utteranceTimer); clearTimeout(this.inputReadyTimer);
    this.capture?.port.postMessage({ type: 'reset' });
    this.preroll = []; this.speechFrames = 0; this.silentFrames = 0; this.update({ recording: false });
  }
  private onCapture(samples: Int16Array, rms: number, final: boolean) {
    if (!(samples instanceof Int16Array) || samples.length > 800) return;
    this.update({ level: Math.min(1, rms * 6) });
    if (!this.view.connected) return;
    if (this.view.handsFree && !this.talking && !this.ending && !this.inputPendingEnd && !final) {
      this.preroll.push(samples); if (this.preroll.length > 5) this.preroll.shift();
      this.speechFrames = rms > .022 ? this.speechFrames + 1 : 0;
      if (this.speechFrames >= 3) { const lead = this.preroll; this.preroll = []; this.beginTalking(); for (const chunk of lead) this.sendSamples(chunk); }
    } else if (this.talking) {
      this.sendSamples(samples);
      if (this.view.handsFree && !this.ending) { this.silentFrames = rms < .014 ? this.silentFrames + 1 : 0; if (this.silentFrames >= 18) this.endTalking(); }
    }
    if (final && this.ending) this.finishInput();
  }
  private sendSamples(samples: Int16Array) {
    if (!samples.length || this.socket?.readyState !== WebSocket.OPEN) return;
    if (!this.inputReady) { this.inputPending.push(samples); if (this.inputPending.reduce((total, frame) => total + frame.length, 0) > 16000 * 2) this.fail('Speech recognition took too long to start. Your microphone stopped; retry or type your question.'); return; }
    if (this.socket.bufferedAmount > 16000 * 2 * 2) { this.fail('Your connection cannot keep up with microphone audio. Voice stopped safely; please retry or type.'); return; }
    this.socket.send(encodeAudioFrame({ kind: 'input', streamId: this.inputStream, outputEpoch: this.epoch, seq: this.inputSeq++, sampleRate: 16000, samples }));
  }
  interrupt(reason: 'control' | 'speech' | 'typing' = 'control') {
    if (!this.view.connected) return;
    this.blockedEpoch = this.epoch;
    for (const prepare of this.visualPrepares.values()) prepare.abort(); this.visualPrepares.clear();
    this.playback?.port.postMessage({ type: 'clear', epoch: this.epoch + 1 });
    this.send({ type: 'input.interrupt', outputEpoch: this.epoch, reason });
    this.update({ state: 'interrupted', caption: '', highlightNodeIds: [], beatId: undefined });
  }
  text(text: string, selectedNodeId?: string, selection?: SelectionContext) {
    if (!this.view.connected) return false;
    this.abandonInput(false);
    this.interrupt('typing'); this.select(selectedNodeId, selection);
    const sent = this.send({ type: 'input.text', requestId: crypto.randomUUID(), text, selectedNodeId, selection });
    if (sent) this.update({ state: 'thinking', partial: '', error: '' }); return sent;
  }
  repeat(messageId: string) { if (!this.view.connected) return; this.interrupt(); this.send({ type: 'input.repeat', messageId }); }
  private receiveAudio(buffer: ArrayBuffer) {
    const frame = decodeAudioFrame(new Uint8Array(buffer));
    if (frame.kind !== 'output') throw new Error('Unexpected input audio');
    if (frame.outputEpoch !== this.epoch || frame.outputEpoch <= this.blockedEpoch) return;
    const stream = this.streams.get(frame.streamId); if (!stream || stream.epoch !== frame.outputEpoch) return;
    if (frame.seq < stream.seq) return;
    if (frame.seq !== stream.seq) throw new Error('Missing audio frame');
    stream.seq++;
    this.playback?.port.postMessage({ type: 'chunk', epoch: frame.outputEpoch, streamId: frame.streamId, samples: frame.samples }, [frame.samples.buffer]);
  }
  private receiveEvent(raw: string) {
    const event = VoiceServerEventSchema.parse(JSON.parse(raw));
    if (event.sessionId !== this.sessionId || (this.connectionId && event.connectionId !== this.connectionId) || event.seq <= this.lastServerSeq) return;
    if (!this.connectionId && event.type !== 'session.ready' && event.type !== 'error') throw new Error('Voice session not initialized');
    this.lastServerSeq = event.seq;
    if (event.outputEpoch < this.epoch) return;
    if (event.outputEpoch > this.epoch) { this.epoch = event.outputEpoch; for (const prepare of this.visualPrepares.values()) prepare.abort(); this.visualPrepares.clear(); this.readyBeats.clear(); this.beats.clear(); this.playback?.port.postMessage({ type: 'clear', epoch: this.epoch }); }
    switch (event.type) {
      case 'session.ready':
        this.connectionId = event.connectionId; this.epoch = event.outputEpoch; this.playback?.port.postMessage({ type: 'clear', epoch: this.epoch }); clearTimeout(this.connectTimer);
        this.displayedBoard = event.session.board; this.displayedMap = event.session.conceptMap; this.displayedSpatial = event.session.spatialState; this.displayedSurface = event.session.visualSurface;
        this.onSession(event.session); this.update({ connected: true, state: 'listening', error: '' }); this.select(this.selectedNodeId, this.selection);
        this.heartbeat = setInterval(() => this.send({ type: 'heartbeat' }), 15000); break;
      case 'session.snapshot': {
        // Live patches own visual application. A history/delivery snapshot must
        // never bypass a pending renderer gate, even if it arrives first.
        this.onSession({ ...event.session, board: this.displayedBoard ?? event.session.board, conceptMap: this.displayedMap, spatialState: this.displayedSpatial, visualSurface: this.displayedSurface });
        break;
      }
      case 'board.patch': {
        const request = this.boardRequests.get(event.operationId);
        if (request) { clearTimeout(request.timer); this.boardRequests.delete(event.operationId); request.resolve(event.board); }
        if (!request && event.outputEpoch <= this.blockedEpoch) break;
        const epoch = event.outputEpoch, generation = this.generation;
        const prepare = new AbortController(); if (event.beatId) this.visualPrepares.set(event.beatId, prepare);
        const highlighted = this.beats.get(event.beatId ?? '')?.highlightNodeIds.filter(id => event.board.nodes.some(node => node.id === id)) ?? [];
        const focusIds = event.beatId ? highlighted.length ? highlighted : event.board.nodes.filter(node => !this.displayedBoard?.nodes.some(previous => previous.id === node.id)).map(node => node.id) : undefined;
        void this.onBoard(event.board, event.beatId, prepare.signal, event.map, focusIds, event.spatialState, event.visualSurface).catch(() => false).then(ready => {
          if (generation !== this.generation || epoch !== this.epoch || epoch <= this.blockedEpoch || !event.beatId) return;
          this.displayedBoard = event.board;
          if (event.map) this.displayedMap = event.map; if(event.spatialState) this.displayedSpatial = event.spatialState; if(event.visualSurface) this.displayedSurface = event.visualSurface;
          if (ready) { this.readyBeats.add(event.beatId); for (const [streamId, stream] of this.streams) if (stream.beatId === event.beatId && stream.epoch === epoch) this.playback?.port.postMessage({ type: 'release', epoch, streamId }); }
          this.send({ type: 'board.ready', beatId: event.beatId, boardRevision: event.board.revision ?? 0, outputEpoch: epoch, ready });
        }).finally(() => { if (event.beatId && this.visualPrepares.get(event.beatId) === prepare) this.visualPrepares.delete(event.beatId); });
        if (request || !event.beatId) this.displayedBoard = event.board;
        break;
      }
      case 'map.patch': if (event.outputEpoch > this.blockedEpoch) { this.displayedMap = event.map; this.onMap(event.map); } break;
      case 'input.ready':
        if (event.streamId !== this.inputStream || (!this.talking && !this.ending && !this.inputPendingEnd)) return;
        this.inputReady = true; clearTimeout(this.inputReadyTimer);
        { const pending = this.inputPending; this.inputPending = []; for (const samples of pending) this.sendSamples(samples); }
        if (this.inputPendingEnd) { this.inputPendingEnd = false; this.send({ type: 'input.audio.end' }); this.update({ state: 'recognizing' }); }
        break;
      case 'session.state': this.update({ state: event.state }); break;
      case 'transcript.partial': this.update({ partial: event.text, state: 'recognizing' }); break;
      case 'transcript.final': this.finalizedAt = performance.now(); this.update({ partial: '', state: 'thinking', audibleMs: undefined }); break;
      case 'tutor.beat': if (event.outputEpoch > this.blockedEpoch) { if (event.beatId) { this.beats.set(event.beatId, { text: event.text, messageId: event.messageId, highlightNodeIds: event.highlightNodeIds ?? [] }); if (this.beats.size > 50) this.beats.delete(this.beats.keys().next().value!); } else this.update({ caption: event.text, messageId: event.messageId }); } break;
      case 'audio.start':
        if (event.outputEpoch <= this.blockedEpoch) return;
        this.streams.set(event.streamId, { epoch: event.outputEpoch, seq: 0, played: 0, messageId: event.messageId, beatId: event.beatId, ...this.beats.get(event.beatId ?? ''), visualReady: event.visualReady !== false });
        this.playback?.port.postMessage({ type: 'start', epoch: event.outputEpoch, streamId: event.streamId, ready: event.visualReady === false || !event.beatId || this.readyBeats.has(event.beatId) }); break;
      case 'audio.end': this.playback?.port.postMessage({ type: 'end', epoch: event.outputEpoch, streamId: event.streamId }); break;
      case 'audio.cancel': this.playback?.port.postMessage({ type: 'clear', epoch: event.outputEpoch }); this.update({ state: 'interrupted', caption: '', highlightNodeIds: [], beatId: undefined }); break;
      case 'voice.metrics': this.update({ metrics: { llmMs: event.llmMs, firstAudioMs: event.firstAudioMs, inputAudioMs: event.inputAudioMs, outputAudioMs: event.outputAudioMs } }); break;
      case 'error': {
        const request = event.operationId ? this.boardRequests.get(event.operationId) : undefined;
        if (request) { clearTimeout(request.timer); this.boardRequests.delete(event.operationId!); request.reject(new RequestError(event.message, event.code === 'BOARD_CONFLICT' ? 409 : 400, event.code)); break; }
        if (['BOARD_NOT_READY', 'VISUAL_UNAVAILABLE', 'TEACHING_WARNING'].includes(event.code)) { this.update({ notice: event.message, highlightNodeIds: [] }); break; }
        if (!event.recoverable) this.fail(event.message); else { this.abandonInput(false); this.update({ error: event.message, state: 'error' }); } break;
      }
      case 'heartbeat': break;
    }
  }
  private onPlayback(data: { type: string; outputEpoch: number; streamId: number; playedSamples: number; status: 'started' | 'progress' | 'completed' | 'interrupted' | 'underrun' }) {
    if (data.type === 'overflow') { this.interrupt(); this.update({ error: 'Playback fell too far behind. The tutor was stopped; please ask it to repeat a shorter explanation.' }); return; }
    if (data.type !== 'ack') return;
    const stream = this.streams.get(data.streamId); if (!stream || data.outputEpoch !== stream.epoch) return;
    if (data.playedSamples < stream.played) return; stream.played = data.playedSamples;
    this.send({ type: 'playback.ack', outputEpoch: data.outputEpoch, streamId: data.streamId, playedSamples: data.playedSamples, status: data.status });
    if (data.outputEpoch === this.epoch && data.outputEpoch > this.blockedEpoch) {
      if (data.status === 'started' && this.finalizedAt !== undefined) { this.update({ audibleMs: Math.round(performance.now() - this.finalizedAt) }); this.finalizedAt = undefined; }
      if (data.status === 'started') this.update({ caption: stream.text ?? this.view.caption, messageId: stream.messageId, beatId: stream.beatId, highlightNodeIds: stream.visualReady ? stream.highlightNodeIds ?? [] : [] });
      if (data.status === 'started' || data.status === 'progress') this.update({ state: 'speaking' });
      if (data.status === 'completed') this.update({ state: 'listening', caption: '', highlightNodeIds: [] });
    }
    if (data.status === 'completed' || data.status === 'interrupted') this.streams.delete(data.streamId);
  }
  stop(state: VoiceState = 'idle') {
    this.intentionalClose = true; this.generation++; clearInterval(this.heartbeat); clearTimeout(this.connectTimer); clearTimeout(this.utteranceTimer); clearTimeout(this.inputReadyTimer);
    this.connectAbort?.abort(); this.connectAbort = undefined;
    for (const prepare of this.visualPrepares.values()) prepare.abort(); this.visualPrepares.clear();
    for (const request of this.boardRequests.values()) { clearTimeout(request.timer); request.reject(new Error('Voice disconnected. Your unsaved board edits are preserved.')); } this.boardRequests.clear(); this.beats.clear(); this.readyBeats.clear();
    for (const [streamId, stream] of this.streams) this.send({ type: 'playback.ack', outputEpoch: stream.epoch, streamId, playedSamples: stream.played, status: 'interrupted' });
    if (state === 'paused') this.send({ type: 'session.pause' });
    this.send({ type: 'session.close' });
    if (this.socket) { this.ownCloseUntil = Date.now() + 3000; this.socket.onmessage = null; this.socket.onclose = null; this.socket.onerror = null; this.socket.close(); this.socket = undefined; }
    this.disableMicrophone();
    if (this.playback) { this.playback.port.onmessage = null; this.playback.port.close(); this.playback.disconnect(); this.playback = undefined; }
    const context = this.context; this.context = undefined; if (context && context.state !== 'closed') void context.close().catch(() => {});
    this.streams.clear(); this.connectionId = undefined; this.finalizedAt = undefined;
    this.update({ state, connected: false, recording: false, microphone: false, handsFree: false, partial: '', caption: '', level: 0, highlightNodeIds: [], beatId: undefined });
  }
  pauseForVisibility() { if (this.view.connected || this.view.state === 'connecting') { this.stop('paused'); this.update({ notice: 'Voice paused because this page was hidden. Reconnect when you’re ready.' }); } }
  private fail(message: string) { this.stop('error'); this.update({ error: message }); }
}
function microphoneError(error: unknown) { if (error instanceof DOMException && error.name === 'NotAllowedError') return 'Microphone permission was denied. Enable it in browser settings to speak.'; if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone was found.'; return error instanceof Error ? error.message : 'The microphone could not start.'; }
