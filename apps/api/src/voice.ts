import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { VoiceClientEventSchema, decodeAudioFrame, encodeAudioFrame, MAX_AUDIO_SAMPLES, type Session, type VoiceClientEvent, type VoiceState, type SelectionContext, type TeachingBeat } from '@tokai/contracts';
import { createTranscriber, createSynthesizer } from '@tokai/speech';
import { type GenerateReply, TutorError } from '@tokai/tutor-core';
import { ApiError, FileStore, type Principal } from './store.js';
import { applySessionBoardTransaction, sceneFailure } from './board-operations.js';
import { planTeachingBeats, appendTeachingBeats, commitBeatVisuals, markTeachingInterrupted } from './teaching.js';

export type VoiceOptions = {
  createTranscriber?: typeof createTranscriber;
  createSynthesizer?: typeof createSynthesizer;
  ticketTtlMs?: number;
  idleTimeoutMs?: number;
  maxSessionMs?: number;
  boardReadyTimeoutMs?: number;
};
type Ticket = { principal: Principal; sessionId: string; expiresAt: number };
type Stream = { id: number; epoch: number; messageId: string; turnId: string; beatId?: string; sentSamples: number; playedSamples: number; ended: boolean; cancelled: boolean; seq: number; pending: Int16Array[]; pendingSamples: number; providerDone: boolean; lastAckAt: number };
type RuntimeOptions = {
  store: FileStore; env: Record<string, string | undefined>; now: () => number;
  tutor: GenerateReply; voice?: VoiceOptions; origin: string;
  httpBusy?: (sessionId: string) => boolean;
};
type Transcriber = Awaited<ReturnType<typeof createTranscriber>>;
type Synthesizer = Awaited<ReturnType<typeof createSynthesizer>>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (raw: RawData): Uint8Array => raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw;

/** Single-process ownership: no provider await holds the durable file mutation lock. */
export class VoiceManager {
  private tickets = new Map<string, Ticket>();
  private sessions = new Map<string, VoiceConnection | 'reserved'>();
  private owners = new Map<string, string>();
  private upgrade = new WeakMap<FastifyRequest, Ticket>();
  private epoch = randomInt(1, 0x0fffffff);
  constructor(private readonly options: RuntimeOptions) {}
  active(sessionId: string) { return this.sessions.has(sessionId); }
  publishBoard(session: Session, operationId: string) { const connection = this.sessions.get(session.id); if (connection && connection !== 'reserved') connection.publishBoard(session, operationId); }
  assertHttpAvailable(sessionId: string) { if (this.active(sessionId)) throw new ApiError(409, 'VOICE_ACTIVE', 'This lesson has an active voice connection. Send text through that connection or disconnect voice first.'); }
  async closeSession(sessionId: string, reason: string) {
    for (const [key, ticket] of this.tickets) if (ticket.sessionId === sessionId) this.tickets.delete(key);
    const connection = this.sessions.get(sessionId);
    if (connection && connection !== 'reserved') await connection.close(reason);
  }
  async register(app: FastifyInstance) {
    await app.register(websocket, { options: { maxPayload: 64 * 1024, perMessageDeflate: false }, errorHandler: (_error, socket) => socket.close(1011, 'Voice connection failed') });
    app.post<{ Params: { id: string } }>('/v1/sessions/:id/voice-ticket', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const header = request.headers.authorization;
      const principal = await this.options.store.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
      const session = await this.options.store.get(principal, request.params.id);
      this.checkSession(session);
      if (this.options.httpBusy?.(session.id)) throw new ApiError(409, 'TURN_ACTIVE', 'Wait for the current text response before connecting voice.');
      if (this.owners.has(principal.hash)) throw new ApiError(409, 'VOICE_ACTIVE', 'This guest already has an active voice connection.');
      const now = this.options.now();
      for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= now || ticket.principal.hash === principal.hash) this.tickets.delete(key);
      if (this.tickets.size >= 100) throw new ApiError(429, 'VOICE_BUSY', 'Voice connections are busy. Please try again shortly.');
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(now + (this.options.voice?.ticketTtlMs ?? 30000), Date.parse(principal.expiresAt));
      this.tickets.set(hash(ticket), { principal, sessionId: session.id, expiresAt });
      return reply.header('Cache-Control', 'no-store').send({ ticket, expiresAt: new Date(expiresAt).toISOString() });
    });
    app.get<{ Querystring: { ticket?: string } }>('/v1/voice', {
      websocket: true,
      preValidation: async request => {
        if (request.headers.upgrade?.toLowerCase() !== 'websocket') throw new ApiError(400, 'UPGRADE_REQUIRED', 'A WebSocket upgrade is required.');
        if (request.headers.origin !== this.options.origin) throw new ApiError(403, 'INVALID_ORIGIN', 'The voice connection origin is not allowed.');
        const raw = request.query.ticket;
        if (!raw || !/^[\w-]{43}$/.test(raw)) throw new ApiError(401, 'INVALID_TICKET', 'A fresh voice ticket is required.');
        const key = hash(raw), ticket = this.tickets.get(key);
        this.tickets.delete(key); // A handshake attempt consumes the ticket.
        if (!ticket || ticket.expiresAt <= this.options.now()) throw new ApiError(401, 'INVALID_TICKET', 'The voice ticket has expired or was already used.');
        this.options.store.assertPrincipal(ticket.principal);
        await this.options.store.locked(ticket.sessionId, async () => {
          this.checkSession(await this.options.store.get(ticket.principal, ticket.sessionId));
          if (this.options.httpBusy?.(ticket.sessionId)) throw new ApiError(409, 'TURN_ACTIVE', 'Wait for the current text response before connecting voice.');
          if (this.sessions.size >= 10) throw new ApiError(429, 'VOICE_BUSY', 'Voice connections are busy. Please try again shortly.');
          if (this.sessions.has(ticket.sessionId) || this.owners.has(ticket.principal.hash)) throw new ApiError(409, 'VOICE_ACTIVE', 'A voice connection already owns this lesson or guest.');
          this.sessions.set(ticket.sessionId, 'reserved');
          this.owners.set(ticket.principal.hash, ticket.sessionId);
          this.upgrade.set(request, ticket);
          const releaseReservation = () => {
            if (this.upgrade.get(request) !== ticket) return;
            this.upgrade.delete(request);
            if (this.sessions.get(ticket.sessionId) === 'reserved') this.sessions.delete(ticket.sessionId);
            if (this.owners.get(ticket.principal.hash) === ticket.sessionId) this.owners.delete(ticket.principal.hash);
          };
          request.raw.socket.once('close', releaseReservation);
          const timer = setTimeout(releaseReservation, 30000); timer.unref();
        });
      }
    }, (socket, request) => {
      const ticket = this.upgrade.get(request);
      if (!ticket) { socket.close(1008, 'Missing voice authorization'); return; }
      this.upgrade.delete(request);
      const connection = new VoiceConnection(socket, ticket, ++this.epoch, this.options, () => {
        if (this.sessions.get(ticket.sessionId) === connection) this.sessions.delete(ticket.sessionId);
        if (this.owners.get(ticket.principal.hash) === ticket.sessionId) this.owners.delete(ticket.principal.hash);
      });
      this.sessions.set(ticket.sessionId, connection);
      connection.attach();
    });
    app.addHook('onClose', async () => { await Promise.all([...this.sessions.values()].map(connection => connection === 'reserved' ? Promise.resolve() : connection.close('Server shutting down'))); this.tickets.clear(); });
  }
  private checkSession(session: Session) {
    if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'This lesson has ended.');
    if (session.mode !== 'live') throw new ApiError(409, 'LIVE_REQUIRED', 'Live voice is available only in a live AI lesson. Sample lessons remain text-based.');
    if (!this.options.env.GEMINI_API_KEY || !this.options.env.GEMINI_MODEL || !this.options.env.ASSEMBLYAI_API_KEY) throw new ApiError(503, 'VOICE_UNAVAILABLE', 'Live voice requires configured Gemini and AssemblyAI credentials on the server.');
  }
}

class VoiceConnection {
  private readonly connectionId = randomUUID();
  private seq = 0;
  private streamId = 0;
  private streams = new Map<number, Stream>();
  private currentStream?: Stream;
  private generation?: AbortController;
  private lifetime = new AbortController();
  private transcriber?: Transcriber;
  private inputController?: AbortController;
  private transcriberOpening?: Promise<void>;
  private synthesizer?: Synthesizer;
  private inputEnabled = false;
  private inputRequested = false;
  private inputStream?: number;
  private lastInputStream = -1;
  private inputSequence = -1;
  private inputAudioMs = 0;
  private selection?: string;
  private selectionContext?: SelectionContext;
  private beatQueue?: { ids: string[]; controller: AbortController; epoch: number; llmMs: number };
  private boardGate?: { beatId: string; revision: number; epoch: number; resolve: (ready: boolean) => void };
  private paused = false;
  private closed = false;
  private ready = false;
  private closeWork?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private startedAt: number;
  private lastActivity: number;
  private rateWindow: number;
  private controls = 0;
  private audioFrames = 0;
  private audioSamples = 0;
  private turns: number[] = [];
  private invalidFrames = 0;
  constructor(private socket: WebSocket, private ticket: Ticket, private epoch: number, private options: RuntimeOptions, private release: () => void) {
    this.startedAt = this.lastActivity = this.rateWindow = options.now();
  }
  attach() {
    this.socket.on('message', (raw, binary) => { void this.receive(raw, binary).catch(error => this.fail(error)); });
    this.socket.on('close', () => { void this.close('Disconnected'); });
    this.socket.on('error', () => { void this.close('Connection error'); });
    this.timer = setInterval(() => {
      const now = this.options.now();
      if (Date.parse(this.ticket.principal.expiresAt) <= now || now - this.startedAt > (this.options.voice?.maxSessionMs ?? 20 * 60 * 1000)) void this.close('Voice session limit reached');
      else if (now - this.lastActivity > (this.options.voice?.idleTimeoutMs ?? 120000)) void this.close('Voice session idle');
      else if (this.currentStream && this.currentStream.sentSamples > this.currentStream.playedSamples && now - this.currentStream.lastAckAt > 10000) void this.close('Playback acknowledgement timed out');
    }, 1000);
    this.timer.unref();
    void this.initialize().catch(error => { this.fail(error); void this.close('Voice initialization failed'); });
  }
  private async initialize() {
    const session = await this.options.store.locked(this.ticket.sessionId, async () => {
      const current = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      if (current.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'The lesson has ended.');
      let changed = false;
      for (const message of current.messages) if (message.role === 'tutor' && ['generated', 'playing'].includes(message.delivery ?? '')) { message.delivery = 'interrupted'; changed = true; }
      if (current.teachingBeats?.some(beat => ['planned', 'ready', 'playing'].includes(beat.status) && beat.outputEpoch !== 0)) { markTeachingInterrupted(current); changed = true; }
      if (changed) await this.save(current);
      return current;
    });
    if (this.closed) return;
    this.ready = true;
    this.emit({ type: 'session.ready', session, inputSampleRate: 16000, outputSampleRate: 24000 });
    this.state('listening');
  }
  private emit(event: Record<string, unknown>) {
    if (this.closed || this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > 1024 * 1024) { void this.close('Output buffer limit reached'); return; }
    this.socket.send(JSON.stringify({ protocolVersion: 1, connectionId: this.connectionId, sessionId: this.ticket.sessionId, seq: this.seq++, outputEpoch: this.epoch, ...event }));
  }
  private state(state: VoiceState) { this.emit({ type: 'session.state', state }); }
  private save(session: Session) { session.revision++; session.updatedAt = new Date(this.options.now()).toISOString(); return this.options.store.save(this.ticket.principal, session); }
  private snapshot(session: Session) { this.emit({ type: 'session.snapshot', session }); }
  publishBoard(session: Session, operationId: string, beatId?: string) {
    if (beatId) { this.emit({ type: 'board.patch', operationId, beatId, board: session.board, map: session.conceptMap }); return; }
    this.snapshot(session); this.emit({ type: 'board.patch', operationId, board: session.board });
    if (session.conceptMap) this.emit({ type: 'map.patch', map: session.conceptMap });
  }
  private fail(error: unknown) {
    if (this.closed) return;
    const known = error instanceof ApiError || error instanceof TutorError;
    this.emit({ type: 'error', code: known ? error.code : 'VOICE_FAILED', message: known ? error.message : 'Live voice could not continue. Your saved text lesson remains available.', recoverable: true });
    this.state('error');
  }
  private async receive(raw: RawData, binary: boolean) {
    if (this.closed) return;
    if (!this.ready) throw new ApiError(409, 'VOICE_CONNECTING', 'Wait for the voice connection to be ready.');
    this.options.store.assertPrincipal(this.ticket.principal);
    const now = this.options.now();
    if (now - this.rateWindow >= 1000) { this.rateWindow = now; this.controls = 0; this.audioFrames = 0; this.audioSamples = 0; }
    if (binary) {
      if (++this.audioFrames > 80) { await this.close('Audio frame rate limit reached'); return; }
      let frame: ReturnType<typeof decodeAudioFrame>;
      try { frame = decodeAudioFrame(bytes(raw)); }
      catch { if (++this.invalidFrames >= 3) await this.close('Invalid audio protocol'); throw new ApiError(400, 'INVALID_AUDIO_FRAME', 'Invalid microphone audio frame.'); }
      if (frame.kind !== 'input' || !this.inputEnabled || this.paused || !this.transcriber) throw new ApiError(400, 'AUDIO_NOT_READY', 'Start microphone input and wait for input.ready before sending audio.');
      if (frame.streamId !== this.inputStream) throw new ApiError(400, 'AUDIO_STREAM_MISMATCH', 'Audio stream changed without starting a new input.');
      if (frame.seq <= this.inputSequence) return;
      if (frame.seq !== this.inputSequence + 1) throw new ApiError(400, 'AUDIO_SEQUENCE_GAP', 'Audio frames arrived out of order. Restart microphone input.');
      this.audioSamples += frame.samples.length;
      if (this.audioSamples > 64000) { await this.close('Audio rate limit reached'); return; }
      this.inputSequence = frame.seq; this.inputAudioMs += frame.samples.length / 16; this.lastActivity = now;
      const pcm = Buffer.alloc(frame.samples.length * 2); frame.samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
      for (let offset = 0; offset < pcm.byteLength; offset += 16000) this.transcriber.sendAudio(pcm.subarray(offset, offset + 16000));
      return;
    }
    if (++this.controls > 60) { await this.close('Control rate limit reached'); return; }
    let event: VoiceClientEvent;
    try { event = VoiceClientEventSchema.parse(JSON.parse(Buffer.from(bytes(raw)).toString('utf8'))); }
    catch { if (++this.invalidFrames >= 3) await this.close('Invalid voice protocol'); throw new ApiError(400, 'INVALID_VOICE_EVENT', 'Invalid voice control event.'); }
    if (!['heartbeat', 'playback.ack'].includes(event.type)) this.lastActivity = now;
    switch (event.type) {
      case 'heartbeat': this.emit({ type: 'heartbeat' }); break;
      case 'input.text': if (this.paused) throw new ApiError(409, 'VOICE_PAUSED', 'Resume voice before sending a message.'); this.closeInput(); await this.acceptTurn(`text:${event.requestId}`, event.text, event.selectedNodeId ?? this.selection, event.selection ?? this.selectionContext); break;
      case 'input.audio.start': await this.startInput(event.streamId); break;
      case 'input.audio.end': this.inputRequested = false; this.inputEnabled = false; this.transcriber?.forceEndpoint(); this.state('recognizing'); break;
      case 'input.interrupt': if (event.outputEpoch === this.epoch) await this.interrupt('Interrupted by learner'); break;
      case 'selection.update': {
        const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
        if (event.selectedNodeId && !session.board.nodes.some(node => node.id === event.selectedNodeId)) throw new ApiError(400, 'INVALID_SELECTION', 'Select an existing board concept.');
        this.selection = event.selectedNodeId; this.selectionContext = event.selection; break;
      }
      case 'board.ready': if (this.boardGate?.beatId === event.beatId && this.boardGate.epoch === event.outputEpoch && this.boardGate.revision === event.boardRevision) this.boardGate.resolve(event.ready); break;
      case 'board.operation': {
        try {
          await this.options.store.locked(this.ticket.sessionId, async () => {
            const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
            if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'The lesson has ended.');
            const result = applySessionBoardTransaction(session, event.transaction, 'student');
            if (!result.duplicate) await this.save(session);
            this.publishBoard(session, event.transaction.operationId);
          });
        } catch (error) { const safe = sceneFailure(error); this.emit({ type: 'error', code: safe.code, message: safe.message, operationId: event.transaction.operationId, recoverable: true }); }
        break;
      }
      case 'input.repeat': await this.repeat(event.messageId); break;
      case 'playback.ack': await this.playback(event); break;
      case 'session.pause': this.paused = true; await this.interrupt('Paused'); await this.closeProviders(); this.state('paused'); break;
      case 'session.resume': this.paused = false; this.state('listening'); break;
      case 'session.close': await this.close('Voice disconnected'); break;
    }
  }
  private async startInput(streamId: number) {
    if (this.paused) throw new ApiError(409, 'VOICE_PAUSED', 'Resume voice before enabling the microphone.');
    if (streamId <= this.lastInputStream) throw new ApiError(400, 'AUDIO_STREAM_REUSED', 'Use a new stream ID for each microphone input.');
    this.closeInput();
    this.lastInputStream = streamId;
    this.inputRequested = true;
    this.inputEnabled = false; this.inputStream = streamId; this.inputSequence = -1;
    if (!this.transcriber && !this.transcriberOpening) {
      this.state('connecting');
      const controller = new AbortController(); this.inputController = controller;
      const inputValid = () => !this.closed && !this.paused && !controller.signal.aborted && this.inputController === controller;
      const opening = (async () => {
        const transcriber = await (this.options.voice?.createTranscriber ?? createTranscriber)({
          apiKey: this.options.env.ASSEMBLYAI_API_KEY!, model: this.options.env.ASSEMBLYAI_STT_MODEL, signal: AbortSignal.any([controller.signal, this.lifetime.signal]),
          onPartial: event => { if (inputValid()) this.emit({ type: 'transcript.partial', turnId: `stt:${hash(event.turnId)}`, text: event.text }); },
          onFinal: event => {
            if (!inputValid()) return;
            if (!this.inputRequested) this.closeInput();
            if (event.text.trim()) void this.acceptTurn(`stt:${hash(event.turnId)}`, event.text, this.selection, this.selectionContext).catch(error => this.fail(error));
          },
          onSpeechStarted: () => { if (inputValid() && this.generation) void this.interrupt('Student started speaking'); },
          onError: () => { if (inputValid()) { this.closeInput(); this.fail(new ApiError(503, 'STT_FAILED', 'Transcription stopped. Use text input or restart the microphone.')); } }
        });
        if (!inputValid()) { await transcriber.close(); return; }
        this.transcriber = transcriber;
      })();
      this.transcriberOpening = opening;
      void opening.finally(() => { if (this.transcriberOpening === opening) this.transcriberOpening = undefined; }).catch(() => undefined);
    }
    if (this.transcriberOpening) await this.transcriberOpening;
    if (!this.closed && !this.paused && this.inputStream === streamId && this.transcriber) {
      if (this.inputRequested) { this.inputEnabled = true; this.emit({ type: 'input.ready', streamId }); this.state('listening'); }
      else { this.transcriber.forceEndpoint(); this.state('recognizing'); }
    }
  }
  private closeInput() {
    this.inputEnabled = false; this.inputRequested = false;
    this.inputController?.abort(); this.inputController = undefined;
    const transcriber = this.transcriber; this.transcriber = undefined; this.transcriberOpening = undefined;
    transcriber?.close();
  }
  private cancelNow(reason: string) {
    this.boardGate?.resolve(false); this.boardGate = undefined; this.beatQueue = undefined;
    this.generation?.abort(); this.generation = undefined;
    this.epoch++;
    const stream = this.currentStream;
    if (stream) { stream.cancelled = true; stream.pending = []; stream.pendingSamples = 0; }
    this.currentStream = undefined;
    void this.synthesizer?.cancel().catch(() => undefined);
    this.emit({ type: 'audio.cancel', reason });
    return stream;
  }
  private async markInterrupted(stream: Stream | undefined) {
    await this.options.store.locked(this.ticket.sessionId, async () => {
      const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      let changed = false;
      if (session.teachingBeats?.some(beat => ['planned', 'ready', 'playing'].includes(beat.status) && beat.outputEpoch !== 0)) { markTeachingInterrupted(session); changed = true; }
      for (const message of session.messages) if (message.role === 'tutor' && ['generated', 'playing'].includes(message.delivery ?? '') && (!stream || message.id === stream.messageId)) {
        message.delivery = 'interrupted'; message.playedMs = stream ? stream.playedSamples / 24 : message.playedMs ?? 0; changed = true;
      }
      if (changed) { await this.save(session); this.snapshot(session); }
    }).catch(() => undefined);
  }
  private async interrupt(reason: string) { const old = this.cancelNow(reason); this.state('interrupted'); await this.markInterrupted(old); if (!this.closed && !this.paused) this.state('listening'); }
  private async acceptTurn(turnId: string, text: string, selectedNodeId?: string, selection?: SelectionContext) {
    if (this.closed || this.paused) return;
    text = text.trim();
    if (!text || text.length > 2000) throw new ApiError(400, 'INPUT_LIMIT', 'Please use a shorter question (up to 2,000 characters).');
    let controller: AbortController | undefined; let context: Session | undefined; let generationEpoch = this.epoch;
    await this.options.store.locked(this.ticket.sessionId, async () => {
      const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      if (this.closed || this.paused) return;
      if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'The lesson has ended.');
      const existing = session.messages.find(message => message.role === 'student' && message.turnId === turnId);
      if (existing) { if (existing.text !== text) throw new ApiError(409, 'REQUEST_ID_REUSED', 'Use a new request ID for a different message.'); this.snapshot(session); return; }
      if (session.messages.length > 198 || (session.teachingBeats?.length ?? 0) > 198) throw new ApiError(429, 'TURN_LIMIT', 'Finish this lesson before starting another conversation.');
      if (selectedNodeId && !session.board.nodes.some(node => node.id === selectedNodeId)) throw new ApiError(400, 'INVALID_SELECTION', 'The selected board item no longer exists.');
      const now = this.options.now(); this.turns = this.turns.filter(at => now - at < 60000);
      if (this.turns.length >= 12) throw new ApiError(429, 'VOICE_RATE_LIMIT', 'Please wait before asking another question.');
      this.turns.push(now);
      const old = this.cancelNow('New student turn');
      markTeachingInterrupted(session);
      for (const message of session.messages) if (message.role === 'tutor' && ['generated', 'playing'].includes(message.delivery ?? '') && (!old || message.id === old.messageId)) {
        message.delivery = 'interrupted'; message.playedMs = old ? old.playedSamples / 24 : message.playedMs ?? 0;
      }
      controller = new AbortController(); this.generation = controller; generationEpoch = this.epoch;
      context = structuredClone(session);
      session.messages.push({ id: randomUUID(), role: 'student', text, turnId, createdAt: new Date(now).toISOString() });
      await this.save(session); this.snapshot(session);
      this.emit({ type: 'transcript.final', turnId, text }); this.state('thinking');
    });
    if (!controller || !context) return;
    const active = controller as AbortController;
    const valid = () => !this.closed && !this.paused && !active.signal.aborted && this.epoch === generationEpoch && this.generation === active;
    const start = this.options.now();
    try {
      const result = await this.options.tutor({ session: context, text, selectedNodeId, selection, apiKey: this.options.env.GEMINI_API_KEY!, model: this.options.env.GEMINI_MODEL!, signal: AbortSignal.any([active.signal, this.lifetime.signal, AbortSignal.timeout(25000)]) });
      if (!valid()) return;
      const beats = planTeachingBeats(context, result, turnId, generationEpoch);
      await this.options.store.locked(this.ticket.sessionId, async () => {
        const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
        if (!valid() || session.status !== 'active') return;
        appendTeachingBeats(session, beats, new Date(this.options.now()).toISOString(), true);
        await this.save(session); this.snapshot(session);
      });
      if (!valid()) return;
      this.beatQueue = { ids: beats.map(beat => beat.beatId), controller: active, epoch: generationEpoch, llmMs: this.options.now() - start };
      await this.nextBeat();
    } catch (error) { if (valid()) { this.fail(error); this.state('listening'); } }
  }
  private waitForBoard(beat: TeachingBeat, controller: AbortController): Promise<boolean> {
    return new Promise(resolve => {
      const gate = { beatId: beat.beatId, revision: beat.boardRevision ?? 0, epoch: beat.outputEpoch, resolve: (_ready: boolean) => undefined as void };
      const finish = (ready: boolean) => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
        if (this.boardGate === gate) this.boardGate = undefined;
        resolve(ready);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), this.options.voice?.boardReadyTimeoutMs ?? 3000);
      gate.resolve = finish; this.boardGate = gate;
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) finish(false);
    });
  }
  private async nextBeat() {
    const queue = this.beatQueue;
    if (!queue) return;
    const valid = () => this.beatQueue === queue && this.generation === queue.controller && !queue.controller.signal.aborted && this.epoch === queue.epoch && !this.closed && !this.paused;
    if (!valid()) return;
    const beatId = queue.ids.shift();
    if (!beatId) { this.beatQueue = undefined; this.generation = undefined; this.state('listening'); return; }
    const committed = await this.options.store.locked(this.ticket.sessionId, async () => {
      const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      if (!valid() || session.status !== 'active') return;
      const result = commitBeatVisuals(session, beatId);
      await this.save(session); return { session, ...result };
    });
    if (!committed || !valid()) return;
    const { beat, session, warning } = committed;
    const hasVisuals = !warning && Boolean(beat.boardCommands.length || beat.highlightNodeIds.length || beat.mapUpdate);
    const readiness = hasVisuals ? this.waitForBoard(beat, queue.controller) : Promise.resolve(false);
    this.emit({ type: 'tutor.beat', turnId: beat.turnId, messageId: beat.messageId, beatId: beat.beatId, text: beat.displayText, spokenText: beat.spokenText, conceptIds: beat.conceptIds, highlightNodeIds: warning ? [] : beat.highlightNodeIds });
    if (hasVisuals) this.publishBoard(session, `beat:${beat.beatId}`, beat.beatId); else this.snapshot(session);
    if (warning) this.emit({ type: 'error', code: 'VISUAL_UNAVAILABLE', message: warning, recoverable: true });
    for (const text of beat.warnings ?? []) if (!warning || !text.startsWith('Visual update unavailable')) this.emit({ type: 'error', code: 'TEACHING_WARNING', message: text, recoverable: true });
    const visualReady = await readiness;
    if (!valid()) return;
    if (hasVisuals && !visualReady) {
      this.emit({ type: 'error', code: 'BOARD_NOT_READY', message: 'The board did not confirm rendering. Continuing with narration; visual timing is unavailable.', recoverable: true });
      await this.options.store.locked(this.ticket.sessionId, async () => {
        const current = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
        if (!valid()) return;
        const saved = current.teachingBeats?.find(value => value.beatId === beatId);
        if (saved) saved.warnings = [...(saved.warnings ?? []), 'Board rendering was not acknowledged; narration continued without synchronized visuals.'].slice(-8);
        await this.save(current); this.snapshot(current);
      });
    } else if (hasVisuals && visualReady) {
      const current = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      if (valid()) this.snapshot(current);
    }
    if (valid()) await this.speak(beat.spokenText, beat.messageId, beat.turnId, queue.controller, queue.llmMs, beat.beatId, visualReady);
  }
  private async repeat(messageId: string) {
    if (this.paused) throw new ApiError(409, 'VOICE_PAUSED', 'Resume voice before replaying.');
    let replay: { text: string; displayText: string; turnId: string; controller: AbortController } | undefined;
    await this.options.store.locked(this.ticket.sessionId, async () => {
      if (this.closed || this.paused) return;
      const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      if (session.status !== 'active') throw new ApiError(409, 'SESSION_ENDED', 'The lesson has ended.');
      const message = session.messages.find(message => message.id === messageId && message.role === 'tutor');
      if (!message) throw new ApiError(404, 'NOT_FOUND', 'Tutor message not found.');
      const now = this.options.now(); this.turns = this.turns.filter(at => now - at < 60000);
      if (this.turns.length >= 12) throw new ApiError(429, 'VOICE_RATE_LIMIT', 'Please wait before replaying speech.');
      this.turns.push(now);
      const old = this.cancelNow('Replay requested');
      markTeachingInterrupted(session);
      for (const oldMessage of session.messages) if (oldMessage.role === 'tutor' && ['generated', 'playing'].includes(oldMessage.delivery ?? '') && (!old || oldMessage.id === old.messageId)) {
        oldMessage.delivery = 'interrupted'; oldMessage.playedMs = old ? old.playedSamples / 24 : oldMessage.playedMs ?? 0;
      }
      if (message.delivery !== 'completed') { message.delivery = 'generated'; message.playedMs = 0; }
      const controller = new AbortController(); this.generation = controller;
      replay = { text: session.teachingBeats?.find(beat => beat.messageId === message.id)?.spokenText ?? message.text, displayText: message.text, turnId: message.turnId ?? `repeat:${message.id}`, controller };
      await this.save(session); this.snapshot(session);
    });
    if (replay && this.generation === replay.controller && !replay.controller.signal.aborted) {
      this.emit({ type: 'tutor.beat', turnId: replay.turnId, messageId, text: replay.displayText });
      await this.speak(replay.text, messageId, replay.turnId, replay.controller, 0);
    }
  }
  private async speak(text: string, messageId: string, turnId: string, controller: AbortController, llmMs: number, beatId?: string, visualReady = true) {
    if (this.closed || this.paused || controller.signal.aborted || this.generation !== controller) return;
    const stream: Stream = { id: ++this.streamId, epoch: this.epoch, messageId, turnId, beatId, sentSamples: 0, playedSamples: 0, ended: false, cancelled: false, seq: 0, pending: [], pendingSamples: 0, providerDone: false, lastAckAt: this.options.now() };
    this.streams.set(stream.id, stream); this.currentStream = stream;
    while (this.streams.size > 16) this.streams.delete(this.streams.keys().next().value!);
    const started = this.options.now(); let firstAudioMs: number | undefined; let synth: Synthesizer | undefined;
    const valid = () => !this.closed && !this.paused && !controller.signal.aborted && this.epoch === stream.epoch && !stream.cancelled && this.generation === controller && this.currentStream === stream;
    this.state('speaking'); this.emit({ type: 'audio.start', streamId: stream.id, turnId, messageId, beatId, visualReady, sampleRate: 24000 });
    try {
      synth = await (this.options.voice?.createSynthesizer ?? createSynthesizer)({
        apiKey: this.options.env.ASSEMBLYAI_API_KEY!, voiceId: this.options.env.ASSEMBLYAI_VOICE_ID, signal: this.lifetime.signal,
        onAudio: pcm => {
          if (!valid() || stream.providerDone) return;
          if (pcm.byteLength % 2) throw new ApiError(503, 'INVALID_AUDIO', 'Speech returned invalid audio.');
          if (firstAudioMs === undefined) firstAudioMs = this.options.now() - started;
          const data = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          for (let offset = 0; offset < pcm.byteLength / 2; offset += MAX_AUDIO_SAMPLES) {
            if (!valid()) return;
            const count = Math.min(MAX_AUDIO_SAMPLES, pcm.byteLength / 2 - offset);
            if (stream.sentSamples + stream.pendingSamples + count > 24000 * 120) { void this.close('Synthesis duration limit reached'); return; }
            const samples = new Int16Array(count); for (let i = 0; i < count; i++) samples[i] = data.getInt16((offset + i) * 2, true);
            stream.pending.push(samples); stream.pendingSamples += count;
          }
          this.drain(stream);
        },
        onError: () => { /* speak rejects; its catch performs one atomic cancellation and failure transition. */ }
      });
      if (!valid()) { await synth.close(); return; }
      this.synthesizer = synth;
      const segments: string[] = [];
      let remaining = text;
      while (remaining) {
        const candidate = [...remaining].slice(0, 1400).join('');
        const boundary = candidate.length < remaining.length ? Math.max(candidate.lastIndexOf('. ') + 1, candidate.lastIndexOf('? ') + 1, candidate.lastIndexOf('! ') + 1, candidate.lastIndexOf(' ')) : candidate.length;
        const length = boundary > candidate.length / 2 ? boundary : candidate.length;
        segments.push(remaining.slice(0, length).trim()); remaining = remaining.slice(length).trim();
      }
      for (let index = 0; index < segments.length && valid(); index++) {
        await synth.speak(segments[index]!, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]), onDone: () => {
          if (valid() && index === segments.length - 1) { stream.providerDone = true; this.drain(stream); }
        } });
      }
      if (valid()) this.emit({ type: 'voice.metrics', turnId, llmMs, ...(firstAudioMs === undefined ? {} : { firstAudioMs }), inputAudioMs: this.inputAudioMs, outputAudioMs: (stream.sentSamples + stream.pendingSamples) / 24 });
    } catch (error) {
      if (valid()) {
        this.cancelNow('Tutor speech failed');
        await this.options.store.locked(this.ticket.sessionId, async () => { const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId); markTeachingInterrupted(session, stream.epoch); const beat = session.teachingBeats?.find(value => value.beatId === beatId); if (beat) { beat.status = 'failed'; beat.playedMs = stream.playedSamples / 24; } const message = session.messages.find(message => message.id === messageId); if (message) { message.delivery = 'failed'; message.playedMs = stream.playedSamples / 24; await this.save(session); this.snapshot(session); } }).catch(() => undefined);
        this.fail(new ApiError(503, 'TTS_FAILED', 'Tutor speech failed. The answer is available as text.')); this.state('listening');
      }
    } finally { synth?.close(); if (this.synthesizer === synth) this.synthesizer = undefined; }
  }
  private async playback(event: Extract<VoiceClientEvent, { type: 'playback.ack' }>) {
    const stream = this.streams.get(event.streamId);
    if (!stream || stream.epoch !== event.outputEpoch) return;
    if (event.playedSamples < stream.playedSamples || event.playedSamples > stream.sentSamples) throw new ApiError(400, 'INVALID_PLAYBACK_ACK', 'Playback acknowledgement exceeds delivered audio.');
    stream.playedSamples = event.playedSamples;
    stream.lastAckAt = this.options.now();
    this.drain(stream);
    const completed = event.status === 'completed' && stream.ended && !stream.cancelled && stream.playedSamples === stream.sentSamples;
    if (event.status === 'completed' && !completed) return;
    await this.options.store.locked(this.ticket.sessionId, async () => {
      const session = await this.options.store.get(this.ticket.principal, this.ticket.sessionId);
      const message = session.messages.find(message => message.id === stream.messageId); if (!message) return;
      if (message.delivery === 'completed') return;
      if ([...this.streams.values()].some(other => other.messageId === stream.messageId && other.id > stream.id)) return;
      message.playedMs = stream.playedSamples / 24;
      if (message.delivery !== 'failed') message.delivery = completed ? 'completed' : stream.cancelled || event.status === 'interrupted' ? 'interrupted' : 'playing';
      const beat = session.teachingBeats?.find(value => value.beatId === stream.beatId);
      if (beat && beat.status !== 'failed') { beat.playedMs = message.playedMs; beat.status = completed ? 'completed' : stream.cancelled || event.status === 'interrupted' ? 'interrupted' : 'playing'; }
      await this.save(session); if (event.status !== 'progress') this.snapshot(session);
    });
    if (completed && this.currentStream === stream) {
      this.currentStream = undefined;
      if (this.beatQueue?.ids.length) await this.nextBeat();
      else { this.beatQueue = undefined; this.generation = undefined; this.state('listening'); }
    }
  }
  private drain(stream: Stream) {
    if (this.closed || stream.cancelled || stream.epoch !== this.epoch || this.socket.readyState !== 1) return;
    // Playback credits keep at most four seconds in the browser; provider audio
    // waits in a separate bounded queue, never an unbounded WebSocket buffer.
    while (stream.pending.length) {
      const credit = 24000 * 4 - (stream.sentSamples - stream.playedSamples);
      if (credit <= 0) break;
      if (this.socket.bufferedAmount > 1024 * 1024) { void this.close('Output buffer limit reached'); return; }
      const first = stream.pending[0]!;
      const count = Math.min(first.length, credit, MAX_AUDIO_SAMPLES);
      const samples = first.slice(0, count);
      if (count === first.length) stream.pending.shift(); else stream.pending[0] = first.slice(count);
      stream.pendingSamples -= count;
      if (stream.sentSamples === 0) stream.lastAckAt = this.options.now();
      this.socket.send(encodeAudioFrame({ kind: 'output', streamId: stream.id, outputEpoch: stream.epoch, seq: stream.seq++, sampleRate: 24000, samples }));
      stream.sentSamples += count;
    }
    if (stream.providerDone && !stream.pending.length && !stream.ended) { stream.ended = true; this.emit({ type: 'audio.end', streamId: stream.id }); }
  }
  private async closeProviders() {
    this.closeInput();
    const synthesizer = this.synthesizer; this.synthesizer = undefined;
    synthesizer?.close();
  }
  close(reason: string): Promise<void> {
    if (this.closeWork) return this.closeWork;
    const old = this.cancelNow(reason); this.state('ended'); this.closed = true;
    this.lifetime.abort(); if (this.timer) clearInterval(this.timer);
    this.socket.close(1000, reason.slice(0, 100));
    this.closeWork = (async () => { await this.markInterrupted(old); await this.closeProviders(); this.release(); })();
    return this.closeWork;
  }
}
