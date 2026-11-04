import { expect, it } from 'vitest';
import { priceUsage, usageRates } from '../src/usage-pricing.js';
import { emptyUsage, sumObservation } from '@tokai/contracts';

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
