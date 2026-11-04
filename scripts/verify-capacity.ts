import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createApp } from '../apps/api/src/app';
import { ConvexStore, NativeObjectStore, type Principal } from '../packages/db/src/index';

async function main() {
  loadEnvFile('.env.local');
  const url = new URL(process.env.CONVEX_URL!);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('This probe only runs against a local Convex deployment.');
  const learners = 4, rounds = 15, store = ConvexStore.fromEnv(process.env), objects = NativeObjectStore.fromEnv(process.env), owners: Principal[] = [];
  const app = await createApp({ store, objects, env: { CONVEX_URL: url.origin }, rateLimit: false });
  const latency: number[] = []; let peakRssBytes = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 25);
  const startMemory = process.memoryUsage().rss, loop = performance.eventLoopUtilization(), started = performance.now();
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    async function json(route: string, token: string | undefined, payload?: unknown) {
      const start = performance.now(), response = await fetch(origin + route, { method: payload === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(20000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const body = await response.json(); latency.push(performance.now() - start);
      if (!response.ok) throw new Error(`Probe request failed (${route}): ${response.status} ${body.code ?? 'UNKNOWN'}`);
      return body;
    }
    const clients = [];
    for (let index = 0; index < learners; index++) {
      const guest = await json('/v1/guest-sessions', undefined, {}); owners.push(await store.authenticate(guest.token));
      const { session } = await json('/v1/sessions', guest.token, { topic: 'fractions', mode: 'sample' }); clients.push({ token: guest.token as string, id: session.id as string });
    }
    const outcomes = await Promise.allSettled(clients.map(async client => {
      for (let turn = 0; turn < rounds; turn++) await json(`/v1/sessions/${client.id}/messages`, client.token, { text: 'Explain equivalent fractions.', requestId: `capacity-${turn}` });
      const { session } = await json(`/v1/sessions/${client.id}`, client.token);
      if (session.messages.filter((message: { role: string }) => message.role === 'student').length !== rounds) throw new Error('A sample turn was lost or duplicated.');
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    const denied = await fetch(`${origin}/v1/sessions/${clients[1]!.id}`, { headers: { Authorization: `Bearer ${clients[0]!.token}` } });
    if (denied.status !== 404) throw new Error('Cross-learner isolation failed under load.');
    latency.sort((a, b) => a - b); const percentile = (p: number) => Math.round(latency[Math.min(latency.length - 1, Math.ceil(p * latency.length) - 1)]!);
    const result = { measuredAt: new Date().toISOString(), mode: 'actual-local-Convex-prepared-lessons', externalProviderRequests: 0, learners, turns: learners * rounds, successfulHttpRequests: latency.length, crossOwnerDenied: true,
      elapsedMs: Math.round(performance.now() - started), latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }, startRssBytes: startMemory, peakRssBytes, finalRssBytes: process.memoryUsage().rss, eventLoopUtilization: Number(performance.eventLoopUtilization(loop).utilization.toFixed(3)),
      limits: 'A short local HTTP concurrency probe; not a live-provider capacity, WebSocket soak, hosted Linux memory, or acoustic latency measurement.' };
    await mkdir('var/probes', { recursive: true }); await writeFile('var/probes/capacity-local.json', JSON.stringify(result, null, 2) + '\n'); console.info(JSON.stringify(result));
  } finally { clearInterval(sample); for (const p of owners) await store.deleteOwner(p); await app.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Capacity probe failed.'); process.exitCode = 1; });
