import { expect, it } from 'vitest';
import { priceUsage, usageRates, priceUpperBound, budgetPolicy } from '../src/usage-pricing.js';
import { emptyUsage, sumObservation } from '@milli/contracts';

// Deliberately synthetic rates; these are arithmetic fixtures, not provider prices.
const rates = usageRates(JSON.stringify({ effectiveDate: '2026-11-04', models: { fixture: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: .5 } }, speechPerMillionCharacters: 10, transcriptionPerHour: 3, ingestionPerGiB: 0 }))!;
it('includes cached input and reasoning output once using the configured model and date', () => {
  const value = priceUsage(rates, 'model', { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 200, thoughtTokens: 50, totalTokens: 1250 }, 1, true, 'fixture');
  expect(value.estimatedUsd).toBeCloseTo(.0037, 10); expect(value).toMatchObject({ pricedRequests: 1, priceDates: ['2026-11-04'] });
  expect(sumObservation(sumObservation(emptyUsage(), value), value)).toMatchObject({ pricedRequests: 2, priceDates: ['2026-11-04'] });
});
it('does not invent prices or treat unknown/failed work as free', () => {
  expect(usageRates(undefined)).toBeUndefined();
  for (const observation of [{}, { inputTokens: 12 }, { inputTokens: 12, outputTokens: 3, totalTokens: 16, toolUseInputTokens: 1 }]) expect(priceUsage(rates, 'model', observation, 1, true, 'fixture')).toEqual({ unpricedRequests: 1 });
  expect(priceUsage(rates, 'model', { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, 1, true, 'other')).toEqual({ unpricedRequests: 1 });
  expect(priceUsage(rates, 'speech', {}, 30, false)).toEqual({ unpricedRequests: 1 });
  expect(() => usageRates('{"effectiveDate":"tomorrow"}')).toThrow('dated USD');
});
it('uses actual audio duration and explicit character/ingestion rates', () => {
  expect(priceUsage(rates, 'speech', {}, 1000, true).estimatedUsd).toBeCloseTo(.01);
  expect(priceUsage(rates, 'transcription', { audioMs: 60000 }, 300000, true).estimatedUsd).toBeCloseTo(.05);
  expect(priceUsage(rates, 'transcription', {}, 300000, true)).toEqual({ unpricedRequests: 1 });
  expect(priceUsage(rates, 'ingestion', {}, 1024, true)).toMatchObject({ estimatedUsd: 0, pricedRequests: 1 });
});
it('leaves contradictory provider counts unpriced and rejects impossible effective dates', () => {
  for (const value of [
    { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 11 },
    { inputTokens: 10, outputTokens: 4, totalTokens: 13 },
    { inputTokens: 10, outputTokens: 4, totalTokens: 16, thoughtTokens: 3 },
    { inputTokens: 10, outputTokens: 4.5, totalTokens: 15 },
    { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: -1 },
  ]) expect(priceUsage(rates, 'model', value, 1, true, 'fixture')).toEqual({ unpricedRequests: 1 });
  expect(() => usageRates(JSON.stringify({ effectiveDate: '2026-02-31', models: {} }))).toThrow('dated USD');
});
it('bounds full verified model capability and rejects missing, mismatched or stale ceilings', () => {
  const now = Date.now(), limit = { model: 'fixture', inputTokenLimit: 10000, outputTokenLimit: 1000, verifiedAt: now };
  expect(priceUpperBound(rates, 'model', 3, { model: 'fixture', modelLimit: limit, now })).toBe(84000);
  for (const modelLimit of [undefined, { ...limit, model: 'other' }, { ...limit, verifiedAt: now - 300001 }]) expect(priceUpperBound(rates, 'model', 1, { model: 'fixture', modelLimit, now })).toBeUndefined();
  expect(budgetPolicy({ TOKAI_OWNER_DAILY_USD: '0.000001', TOKAI_GLOBAL_DAILY_USD: '2.15' })).toEqual({ ownerMicros: 1, globalMicros: 2150000 });
  for (const amount of ['-1', '1e6', '0.0000001', 'NaN']) expect(() => budgetPolicy({ TOKAI_OWNER_DAILY_USD: amount })).toThrow();
});
it('bounds storage lifetime and prepared download bytes without claiming indefinite storage is free', () => {
  const configured = usageRates(JSON.stringify({ effectiveDate: '2026-11-04', storagePerGiBDay: .2, egressPerGiB: .3 }))!;
  expect(priceUpperBound(configured, 'storage', 1073741824, { now: 0, retentionDays: 10 })).toBe(2000000);
  expect(priceUpperBound(configured, 'storage', 1073741824, { now: 0 })).toBeUndefined();
  expect(priceUpperBound(configured, 'egress', 1073741824, { now: 0 })).toBe(300000);
});
