import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApp, type AppOptions } from '../apps/api/src/app';
import { ConvexStore, NativeObjectStore, StoreError, type Principal } from '../packages/db/src/index';
import { decodeAudioFrame, encodeAudioFrame, TeachingBeatProposalSchema, VoiceServerEventSchema, type VoiceServerEvent, type Session } from '../packages/contracts/src/index';
import { createIsolatedConvex } from './isolated-convex';

const DURATION_MS = 180000, WARMUP_MS = 30000, CYCLE_MS = 15000, LEARNERS = 3;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(checker: () => boolean | Promise<boolean>, label: string, timeout = 10000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await checker()) return; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}

async function runSoak(probeEnv: Record<string, string | undefined>) {
  const gc = (globalThis as { gc?: () => void }).gc;
  check(gc, 'Run with node --expose-gc --import tsx scripts/verify-voice-soak.ts.');
  const convex = new URL(probeEnv.CONVEX_URL!);
  check(convex.origin === 'http://127.0.0.1:3214', 'Voice soak requires its fresh isolated Convex deployment.');
  const originalFetch = globalThis.fetch;
  let deniedExternalFetches = 0;
  globalThis.fetch = ((input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { deniedExternalFetches++; throw new Error('The offline soak blocked a nonlocal request.'); }
    return originalFetch(input, init);
  }) as typeof fetch;

  const counters = { connections: 0, gracefulCloses: 0, abruptCloses: 0, rotations: 0, completedTurns: 0, interruptedTurns: 0, delayedTurns: 0, duplicateTurns: 0, competingOwnersDenied: 0, fenceReleases: 0, staleFenceWritesDenied: 0, leaseRenewals: 0, microphonePackets: 0, lateAudioAttempts: 0, staleAudioFrames: 0, protocolErrors: 0, unhandledErrors: 0 };
  const sockets = new Set<WebSocket>(), synths = new Set<string>(), transcribers = new Set<string>(), providerTimers = new Set<ReturnType<typeof setTimeout>>(), delayedStarted = new Set<string>();
  const latestFence = new Map<string, number>(), owners: Principal[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
  const memory: { elapsedMs: number; rss: number; heapUsed: number; external: number; activeSockets: number }[] = [];
  const fatalErrors: string[] = [];
  const onUnhandled = () => { counters.unhandledErrors++; fatalErrors.push('Unhandled asynchronous error'); };
  process.on('unhandledRejection', onUnhandled); process.on('uncaughtExceptionMonitor', onUnhandled);
  let memoryTimer: ReturnType<typeof setInterval> | undefined, peakTimer: ReturnType<typeof setInterval> | undefined;
  let peakRss = process.memoryUsage().rss, activeTutorCalls = 0, peakSockets = 0;
  const stores = [ConvexStore.fromEnv(probeEnv), ConvexStore.fromEnv(probeEnv)];
  for (const store of stores) {
    const consume = store.voiceTickets.consumeAndAcquire.bind(store.voiceTickets), renew = store.renewFence.bind(store);
    store.voiceTickets.consumeAndAcquire = async (...args) => { const ticket = await consume(...args); latestFence.set(ticket.principal.ownerId, ticket.fence); return ticket; };
    store.renewFence = async (...args) => { const result = await renew(...args); if (result) counters.leaseRenewals++; return result; };
  }
  const objects = NativeObjectStore.fromEnv(probeEnv);
  const env = { CONVEX_URL: convex.origin, GEMINI_API_KEY: 'soak-injected-only', GEMINI_MODEL: 'soak-injected-only', ASSEMBLYAI_API_KEY: 'soak-injected-only', TOKAI_NATIVE_AUTH: '0', APP_ORIGIN: 'http://localhost:3000' };
  const options: Omit<AppOptions, 'store'> = {
    objects, env, rateLimit: false,
    tutor: async ({ text }) => {
      activeTutorCalls++;
      try {
        if (text.startsWith('deferred-')) {
          delayedStarted.add(text);
          await delay(450); // Deliberately ignore AbortSignal to exercise the commit fence.
          return { text: 'A stale tutor result must be discarded.', beats: [TeachingBeatProposalSchema.parse({ spokenText: 'Discard this cancelled explanation.', displayText: 'Discard this cancelled explanation.', boardCommands: [{ type: 'upsert_node', node: { id: `stale-${text}`, label: 'Must never be committed', detail: 'Cancelled soak output', kind: 'concept', x: 20, y: 20 } }] })] };
        }
        return { text: text.startsWith('cancel-') ? 'Synthetic cancellation response.' : 'Synthetic completed response.' };
      } finally { activeTutorCalls--; }
    },
    speech: async () => { throw new Error('HTTP speech is outside this offline soak.'); },
    voice: {
      rotateAfterMs: 12000, rotateGraceMs: 2000, maxSessionMs: 60000, idleTimeoutMs: 60000,
      createTranscriber: async () => {
        const id = randomUUID(); transcribers.add(id); let closed = false;
        return { sendAudio: () => { if (!closed) counters.microphonePackets++; }, forceEndpoint: () => {}, close: () => { closed = true; transcribers.delete(id); } };
      },
      createSynthesizer: async input => {
        const id = randomUUID(); synths.add(id); let stopped = false;
        const identity = { providerSessionId: id, flushId: 0 };
        return {
          speak: async (_text, call = {}) => {
            call.onStart?.(identity);
            for (let index = 0; index < 12; index++) {
              if (stopped || call.signal?.aborted || input.signal?.aborted) throw new Error('Synthetic synthesis cancelled');
              input.onAudio(new Uint8Array(2400), identity); await delay(20);
            }
            call.onDone?.({ ...identity, audioDurationMs: 600 });
          },
          cancel: async () => {
            stopped = true;
            const timer = setTimeout(() => { providerTimers.delete(timer); counters.lateAudioAttempts++; input.onAudio(new Uint8Array(2400), identity); }, 40);
            providerTimers.add(timer);
          },
          close: () => { stopped = true; synths.delete(id); },
        };
      },
    },
  };
  const started = performance.now();
  let measuredStart = 0;
  let completed = false;
  try {
    for (const store of stores) apps.push(await createApp({ ...options, store }));
    const origins = await Promise.all(apps.map(app => app.listen({ host: '127.0.0.1', port: 0 })));
    const clients: { principal: Principal; token: string; id: string; epochs: Set<number>; lastFence?: number; expectedStudentTurns: number }[] = [];
    for (let index = 0; index < LEARNERS; index++) {
      const guest = await stores[0]!.createGuest(), principal = await stores[0]!.authenticate(guest.token); owners.push(principal);
      const result = await apps[0]!.inject({ method: 'POST', url: '/v1/sessions', headers: { authorization: `Bearer ${guest.token}` }, payload: { topic: 'photosynthesis', mode: 'live' } });
      check(result.statusCode === 201, `Soak lesson creation returned ${result.statusCode}.`);
      clients.push({ principal, token: guest.token, id: (result.json().session as Session).id, epochs: new Set(), expectedStudentTurns: 0 });
    }
    const isolated = await apps[1]!.inject({ method: 'GET', url: `/v1/sessions/${clients[1]!.id}`, headers: { authorization: `Bearer ${clients[0]!.token}` } });
    check(isolated.statusCode === 404, 'Cross-owner isolation failed.');
    measuredStart = performance.now();
    const sample = () => { gc(); const m = process.memoryUsage(); memory.push({ elapsedMs: Math.round(performance.now() - measuredStart), rss: m.rss, heapUsed: m.heapUsed, external: m.external, activeSockets: sockets.size }); };
    sample(); memoryTimer = setInterval(sample, 10000);
    peakTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); peakSockets = Math.max(peakSockets, sockets.size); }, 1000);
    async function ticket(client: typeof clients[number], appIndex: number) {
      const value = await apps[appIndex]!.inject({ method: 'POST', url: `/v1/sessions/${client.id}/voice-ticket`, headers: { authorization: `Bearer ${client.token}` } });
      check(value.statusCode === 200, `Soak ticket request returned ${value.statusCode}.`); return String(value.json().ticket);
    }
    const runs = await Promise.allSettled(clients.map(async (client, learner) => {
      await delay(learner * 100);
      for (let cycle = 0; cycle < DURATION_MS / CYCLE_MS; cycle++) {
        const cycleStart = performance.now(), apiIndex = cycle % 2;
        const ws = new WebSocket(`${origins[apiIndex]!.replace('http:', 'ws:')}/v1/voice?ticket=${await ticket(client, 1 - apiIndex)}`, { origin: env.APP_ORIGIN }); sockets.add(ws);
        const events: VoiceServerEvent[] = [], streams = new Map<number, { epoch: number; samples: number; turnId: string }>(); let epoch = -1, closeCode: number | undefined;
        ws.on('error', () => fatalErrors.push('Unexpected client WebSocket error'));
        ws.on('close', code => { closeCode = code; sockets.delete(ws); });
        const send = (event: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
        ws.on('message', (raw, binary) => {
          try {
            if (binary) {
              const frame = decodeAudioFrame(new Uint8Array(raw as Buffer));
              if (frame.outputEpoch < epoch) counters.staleAudioFrames++;
              const stream = streams.get(frame.streamId); if (stream) stream.samples += frame.samples.length;
              return;
            }
            const event = VoiceServerEventSchema.parse(JSON.parse(raw.toString())); epoch = event.outputEpoch; events.push(event);
            if (events.length > 100) events.shift();
            if (event.type === 'error') { counters.protocolErrors++; fatalErrors.push(`Voice protocol code: ${event.code}`); }
            if (event.type === 'board.patch' && event.beatId) send({ type: 'board.ready', beatId: event.beatId, outputEpoch: event.outputEpoch, boardRevision: event.board.revision ?? 0, ready: true });
            if (event.type === 'audio.start') streams.set(event.streamId, { epoch: event.outputEpoch, samples: 0, turnId: event.turnId });
            if (event.type === 'audio.end') { const stream = streams.get(event.streamId); if (stream?.turnId.includes('complete-')) send({ type: 'playback.ack', streamId: event.streamId, outputEpoch: stream.epoch, playedSamples: stream.samples, status: 'completed' }); }
          } catch { counters.protocolErrors++; fatalErrors.push('Invalid server protocol event'); }
        });
        await until(() => events.some(event => event.type === 'session.ready'), 'voice ready'); counters.connections++;
        check(!client.epochs.has(epoch), 'A reconnect reused a previous output epoch.'); client.epochs.add(epoch);
        const fence = latestFence.get(client.principal.ownerId); check(fence !== undefined && (client.lastFence === undefined || fence > client.lastFence), 'Voice fence did not advance on reconnect.'); client.lastFence = fence;
        check(await stores[1]!.fenceActive(`voice:${client.principal.ownerId}`), 'Connected voice has no durable owner fence.');
        const rival = new WebSocket(`${origins[1 - apiIndex]!.replace('http:', 'ws:')}/v1/voice?ticket=${await ticket(client, 1 - apiIndex)}`, { origin: env.APP_ORIGIN });
        const denied = await new Promise<number>((resolve, reject) => { const timer = setTimeout(() => { rival.terminate(); reject(new Error('Competing voice connection did not finish.')); }, 5000); rival.on('error', () => {}); rival.once('unexpected-response', (_request, response) => { response.resume(); clearTimeout(timer); rival.terminate(); resolve(response.statusCode!); }); rival.once('open', () => { clearTimeout(timer); rival.terminate(); reject(new Error('Competing voice ownership was accepted.')); }); });
        check(denied === 409, `Competing voice connection returned ${denied}.`); counters.competingOwnersDenied++;
        const completeId = `complete-${learner}-${cycle}`;
        send({ type: 'input.text', requestId: completeId, text: completeId }); client.expectedStudentTurns++;
        await until(() => events.some(event => event.type === 'session.snapshot' && event.session.messages.some(message => message.turnId === `text:${completeId}` && message.role === 'tutor' && message.delivery === 'completed')), 'completed playback snapshot'); counters.completedTurns++;
        send({ type: 'input.text', requestId: completeId, text: completeId }); await delay(80); counters.duplicateTurns++;
        const cancelId = `cancel-${learner}-${cycle}`;
        send({ type: 'input.text', requestId: cancelId, text: cancelId }); client.expectedStudentTurns++;
        await until(() => [...streams.values()].some(stream => stream.turnId === `text:${cancelId}` && stream.samples > 0), 'cancellable audio');
        const cancelledEpoch = epoch; send({ type: 'input.interrupt', outputEpoch: epoch, reason: 'control' });
        await until(() => epoch > cancelledEpoch, 'output epoch invalidation'); counters.interruptedTurns++;
        const deferred = `deferred-${learner}-${cycle}`;
        send({ type: 'input.text', requestId: deferred, text: deferred }); client.expectedStudentTurns++;
        await until(() => delayedStarted.has(deferred), 'delayed tutor started');
        const deferredEpoch = epoch; send({ type: 'input.interrupt', outputEpoch: epoch, reason: 'typing' });
        await until(() => epoch > deferredEpoch, 'delayed generation cancellation'); await delay(600); delayedStarted.delete(deferred); counters.delayedTurns++;
        const microphone = cycle + 1;
        send({ type: 'input.audio.start', streamId: microphone }); await until(() => events.some(event => event.type === 'input.ready' && event.streamId === microphone), 'synthetic microphone ready');
        for (let seq = 0; seq < 2; seq++) ws.send(encodeAudioFrame({ kind: 'input', streamId: microphone, outputEpoch: 0, seq, sampleRate: 16000, samples: new Int16Array(1600) }));
        send({ type: 'session.pause' }); await until(() => events.some(event => event.type === 'session.state' && event.state === 'paused'), 'microphone pause'); send({ type: 'session.resume' });
        if (cycle % 3 === 2) { await until(() => closeCode !== undefined, 'planned rotation', 16000); check(closeCode === 1012, `Rotation closed with ${closeCode}.`); counters.rotations++; }
        else if (cycle % 3 === 1) { ws.terminate(); await until(() => closeCode !== undefined, 'abrupt disconnect'); counters.abruptCloses++; }
        else { send({ type: 'session.close' }); await until(() => closeCode !== undefined, 'graceful disconnect'); counters.gracefulCloses++; }
        await until(async () => !await stores[1]!.fenceActive(`voice:${client.principal.ownerId}`), 'durable fence release'); counters.fenceReleases++;
        const saved = await stores[1]!.get(client.principal, client.id);
        check(!saved.board.nodes.some(node => node.id.startsWith('stale-deferred-')), 'A cancelled tutor diagram reached persistent state.');
        check(saved.messages.filter(message => message.role === 'student').length === client.expectedStudentTurns, 'A learner turn was lost or duplicated.');
        const beforeRevision = saved.revision;
        try { await stores[0]!.save(client.principal, { ...saved, revision: saved.revision + 1 }, { lease: { key: `voice:${client.principal.ownerId}`, fence } }); throw new Error('A released voice fence could still save.'); }
        catch (error) { check(error instanceof StoreError && error.code === 'LEASE_LOST', 'A released fence was not rejected as LEASE_LOST.'); counters.staleFenceWritesDenied++; }
        check((await stores[1]!.get(client.principal, client.id)).revision === beforeRevision, 'Rejected stale work changed the session revision.');
        check(!fatalErrors.length, fatalErrors[0] ?? 'Unexpected soak failure.');
        await delay(Math.max(0, CYCLE_MS - (performance.now() - cycleStart)));
      }
    }));
    for (const run of runs) if (run.status === 'rejected') throw run.reason;
    await until(() => !sockets.size && !synths.size && !transcribers.size && !activeTutorCalls && !providerTimers.size, 'all resources settled');
    sample();
    const settled = process.memoryUsage(), postWarmup = memory.filter(item => item.elapsedMs >= WARMUP_MS);
    check(postWarmup.length >= 10, 'Insufficient post-warmup memory samples.');
    const baseHeap = Math.min(...postWarmup.slice(0, 3).map(item => item.heapUsed)), baseRss = Math.min(...postWarmup.slice(0, 3).map(item => item.rss));
    const retainedHeapGrowth = settled.heapUsed - baseHeap, rssGrowth = settled.rss - baseRss;
    check(retainedHeapGrowth < 64 * 1024 * 1024, 'Retained heap grew beyond the 64 MiB soak budget.');
    check(rssGrowth < 192 * 1024 * 1024 && peakRss < 768 * 1024 * 1024, 'Process RSS exceeded the bounded soak budget.');
    check(counters.rotations >= LEARNERS * 3 && counters.leaseRenewals >= LEARNERS * 3, 'The soak did not exercise enough actual rotations and lease renewals.');
    check(counters.staleAudioFrames === 0 && counters.protocolErrors === 0 && counters.unhandledErrors === 0 && deniedExternalFetches === 0 && !fatalErrors.length, 'The soak observed a protocol, asynchronous or external-request failure.');
    completed = true;
    const report = { measuredAt: new Date().toISOString(), mode: 'fresh-isolated-native-Convex-two-API-instances-with-injected-providers', providerRequests: 0, mainDatabaseAccessed: false, durationMs: Math.round(performance.now() - measuredStart), totalElapsedMs: Math.round(performance.now() - started), learners: LEARNERS, apiInstances: 2, warmupMs: WARMUP_MS, cycleMs: CYCLE_MS, rotationMs: 12000, counters, peakSockets, activeAtEnd: { sockets: sockets.size, synthesizers: synths.size, transcribers: transcribers.size, tutorCalls: activeTutorCalls, providerTimers: providerTimers.size }, memory: { sampleEveryMs: 10000, forcedGc: true, retainedHeapGrowthBytes: retainedHeapGrowth, rssGrowthBytes: rssGrowth, peakRssBytes: peakRss, samples: memory }, crossOwnerIsolation: true, limits: 'Three-minute isolated native Convex soak with simulated providers and simulated playback ACKs. Two API instances and clients share one measured Node process. It does not measure browser/device memory, real speech quality, hosted capacity, Convex-process memory, or long-duration leak freedom.' };
    await mkdir('var/probes', { recursive: true }); await writeFile('var/probes/voice-soak-local.json', JSON.stringify(report, null, 2) + '\n');
    console.info(JSON.stringify({ ...report, memory: { ...report.memory, samples: memory.length } }));
  } finally {
    if (memoryTimer) clearInterval(memoryTimer); if (peakTimer) clearInterval(peakTimer);
    for (const socket of sockets) socket.terminate();
    for (const timer of providerTimers) clearTimeout(timer);
    await Promise.allSettled(apps.map(app => app.close()));
    for (const owner of owners) await stores[0]!.deleteOwner(owner);
    globalThis.fetch = originalFetch;
    process.off('unhandledRejection', onUnhandled); process.off('uncaughtExceptionMonitor', onUnhandled);
    if (!completed) console.error('Voice soak did not pass; its isolated learner data was removed.');
  }
}
async function main() {
  check(typeof (globalThis as { gc?: unknown }).gc === 'function', 'Run with node --expose-gc --import tsx scripts/verify-voice-soak.ts.');
  console.info(JSON.stringify({ stage: 'initialize-fresh-isolated-Convex', cloudPort: 3214, sitePort: 3215 }));
  const isolated = await createIsolatedConvex({ name: 'voice-soak', cloudPort: 3214, sitePort: 3215 });
  try { console.info(JSON.stringify({ stage: 'run-180-second-soak', simulatedProviders: true })); await runSoak(isolated.env); }
  finally { await isolated.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Voice soak failed.'); process.exitCode = 1; });
