import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { FileStore, type Principal } from '@milli/db';
import { UsageMeter } from '../src/usage.js';

let directory: string, store: FileStore, p: Principal, q: Principal, other: Principal, time: number;
beforeEach(async () => {
  time = Date.parse('2026-11-04T12:00:00Z'); directory = await mkdtemp(path.join(tmpdir(), 'tokai-usage-'));
  store = new FileStore(directory, () => time); await store.initialize();
  p = await store.authenticate((await store.createGuest()).token); q = await store.authenticate((await store.createGuest()).token); other = await store.authenticate((await store.createGuest()).token);
});
afterEach(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
const env = { TOKAI_MODEL_DAILY_UNITS: '4', TOKAI_MODEL_GLOBAL_DAILY_UNITS: '6', TOKAI_MODEL_GLOBAL_CONCURRENCY: '2' };
const meter = () => new UsageMeter(store, env, () => time);

it('shares owner/global admission across API meter instances and settles once', async () => {
  const first = meter(), second = meter(), a = await first.begin(p, 'model', 2);
  await expect(second.begin(p, 'model', 1)).rejects.toMatchObject({ code: 'WORK_CAPACITY' });
  const b = await second.begin(q, 'model', 2);
  await expect(first.begin(other, 'model', 1)).rejects.toMatchObject({ code: 'WORK_CAPACITY' });
  await a.finish(true, 1, { inputTokens: 100 }); await a.finish(true, 0, { inputTokens: 100 }); await b.finish(true, 2);
  const summary = await second.summary(p); expect(summary.kinds[0]).toMatchObject({ used: 1, remaining: 3, active: 0, totals: { requests: 1, succeeded: 1, inputTokens: 100 } });
  const c = await first.begin(other, 'model', 3); await c.finish(false);
  await expect(second.begin(p, 'model', 1)).rejects.toMatchObject({ code: 'DAILY_USAGE_LIMIT' });
});
it('keeps unknown failed/crashed work reserved, frees only concurrency on expiry, and resets by UTC day', async () => {
  const usage = meter(); await usage.begin(p, 'model', 3); time += 91000;
  const retry = await usage.begin(p, 'model', 1); await retry.finish(false);
  await expect(usage.begin(p, 'model', 1)).rejects.toMatchObject({ code: 'DAILY_USAGE_LIMIT' });
  const summary = await usage.summary(p); expect(summary.kinds[0]!.totals).toMatchObject({ units: 4, failed: 1 }); expect(summary.kinds[0]!.totals.inputTokens).toBeUndefined();
  time = Date.parse('2026-11-05T00:00:01Z'); const fresh = await usage.begin(p, 'model', 1); await fresh.finish(true, 1);
  expect((await usage.summary(p)).kinds[0]!.used).toBe(1);
});
it('accumulates provider-reported metadata without inventing billing or missing token measurements', async () => {
  const usage = meter();
  const value = await usage.run(p, 'model', 3, async observe => { observe({ provider: 'gemini', model: 'configured-test-model', requestId: 'trace-1', inputTokens: 30, outputTokens: 10, totalTokens: 44, thoughtTokens: 4 }); return 'saved'; });
  expect(value).toBe('saved');
  const summary = await usage.summary(p); expect(summary.pricing).toBe('not-configured'); expect(summary.estimatedUsd).toBeUndefined();
  expect(summary.kinds[0]).toMatchObject({ used: 1, totals: { inputTokens: 30, outputTokens: 10, thoughtTokens: 4, totalTokens: 44 } });
  await expect(usage.run(p, 'model', 3, async () => { throw new Error('Provider failed'); })).rejects.toThrow('Provider failed');
  expect((await usage.summary(p)).kinds[0]!.used).toBe(4);
});
it('rejects deleted owners and invalid/disabled budgets before starting work', async () => {
  const usage = meter(); await store.deleteOwner(p); await expect(usage.begin(p, 'model', 1)).rejects.toBeDefined();
  const disabled = new UsageMeter(store, { TOKAI_MODEL_DAILY_UNITS: '0' }, () => time);
  await expect(disabled.begin(q, 'model', 1)).rejects.toMatchObject({ code: 'DAILY_USAGE_LIMIT' });
  expect(() => new UsageMeter(store, { TOKAI_MODEL_DAILY_UNITS: 'NaN' })).toThrow('Invalid usage setting');
});
it('does not label a known provider-free fallback as an unpriced provider request', async () => {
  const usage = new UsageMeter(store, { ...env, TOKAI_USAGE_RATES_JSON: JSON.stringify({ effectiveDate: '2026-11-04', models: {} }) }, () => time);
  await usage.run(p, 'model', 3, async () => 'No supporting source was found; no model called.', { usedUnits: () => 0 });
  const totals = (await usage.summary(p)).kinds.find(kind => kind.kind === 'model')!.totals;
  expect(totals.units).toBe(0); expect(totals.unpricedRequests).toBeUndefined(); expect(totals.pricedRequests).toBeUndefined(); expect(totals.estimatedUsd).toBeUndefined();
  const cancelledSpeech = await usage.begin(p, 'speech', 20); await cancelledSpeech.finish(true, 0);
  expect((await usage.summary(p)).kinds.find(kind => kind.kind === 'speech')!.totals.pricedRequests).toBeUndefined();
});
it('admits conservative USD commitments atomically across owners, settles actual measurements once and retains unknown failures', async () => {
  const rates = { effectiveDate: '2026-11-04', models: { fixture: { inputPerMillion: 2, outputPerMillion: 8 } }, speechPerMillionCharacters: 10000 };
  const config = { GEMINI_MODEL: 'fixture', TOKAI_OWNER_DAILY_USD: '0.10', TOKAI_GLOBAL_DAILY_USD: '0.05', TOKAI_USAGE_RATES_JSON: JSON.stringify(rates) };
  const lookup = async () => ({ model: 'fixture', inputTokenLimit: 10000, outputTokenLimit: 1000, verifiedAt: time });
  const a = new UsageMeter(store, config, () => time, lookup), b = new UsageMeter(store, config, () => time, lookup);
  const first = await a.begin(p, 'model', 1);
  await expect(b.begin(q, 'model', 1)).rejects.toMatchObject({ code: 'DAILY_USD_LIMIT' });
  expect((await b.summary(p)).budget).toMatchObject({ ownerUsedUsd: .028, globalUsedUsd: .028, globalRemainingUsd: .022 });
  await first.finish(true, 1, { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, estimatedUsd: .0028, pricedRequests: 1 });
  await first.finish(true, 0, { estimatedUsd: 0 });
  expect((await a.summary(p)).budget?.globalUsedUsd).toBe(.0028);
  const second = await b.begin(q, 'model', 1); await second.finish(false);
  expect((await a.summary(q)).budget?.globalUsedUsd).toBe(.0308);
  await expect(a.begin(other, 'speech', 2)).rejects.toMatchObject({ code: 'DAILY_USD_LIMIT' });
});
it('fails closed before generation when a configured dollar cap has no trusted bound', async () => {
  let work = 0, lookups = 0;
  const usage = new UsageMeter(store, { GEMINI_MODEL: 'fixture', TOKAI_OWNER_DAILY_USD: '1' }, () => time, async () => { lookups++; return { model: 'fixture', inputTokenLimit: 1000, outputTokenLimit: 10, verifiedAt: time }; });
  await expect(usage.run(p, 'model', 1, async () => { work++; })).rejects.toMatchObject({ code: 'USD_BOUND_UNAVAILABLE' });
  expect(work).toBe(0); expect(lookups).toBe(1); expect((await usage.summary(p)).kinds[0]!.used).toBe(0);
  const storage = new UsageMeter(store, { TOKAI_OWNER_DAILY_USD: '1', TOKAI_USAGE_RATES_JSON: JSON.stringify({ effectiveDate: '2026-11-04', storagePerGiBDay: .1 }) }, () => time);
  await expect(storage.begin(p, 'storage', 1000)).rejects.toMatchObject({ code: 'USD_BOUND_UNAVAILABLE' });
});
it('does not hide earlier unbounded work when rates are configured later in the same UTC day', async () => {
  const unpriced = new UsageMeter(store, {}, () => time), old = await unpriced.begin(p, 'speech', 1); await old.finish(true, 1);
  const pricedEnv = { TOKAI_USAGE_RATES_JSON: JSON.stringify({ effectiveDate: '2026-11-04', speechPerMillionCharacters: 1 }) };
  const priced = new UsageMeter(store, pricedEnv, () => time), later = await priced.begin(p, 'speech', 1); await later.finish(true, 1);
  const capped = new UsageMeter(store, { ...pricedEnv, TOKAI_OWNER_DAILY_USD: '1' }, () => time);
  await expect(capped.begin(p, 'speech', 1)).rejects.toMatchObject({ code: 'USD_HISTORY_CONFIGURATION' });
});
