import { z } from 'zod';
import type { UsageKind, UsageObservation } from '@tokai/contracts';

const rate = z.number().finite().min(0).max(1000000);
const RatesSchema = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value),
  models: z.record(z.string().min(1).max(200), z.object({ inputPerMillion: rate, outputPerMillion: rate, cachedInputPerMillion: rate.optional() }).strict()).default({}),
  speechPerMillionCharacters: rate.optional(), transcriptionPerHour: rate.optional(), ingestionPerGiB: rate.optional(),
}).strict();
export type UsageRates = z.infer<typeof RatesSchema>;
/** Operator-supplied, dated USD rates. No default prices or account billing assumptions. */
export function usageRates(raw: string | undefined): UsageRates | undefined {
  if (!raw) return undefined;
  try { return RatesSchema.parse(JSON.parse(raw)); } catch { throw new Error('TOKAI_USAGE_RATES_JSON must be a valid dated USD rate table.'); }
}
export function priceUsage(rates: UsageRates, kind: UsageKind, value: UsageObservation, units: number, success: boolean, model?: string): UsageObservation {
  const unknown = { unpricedRequests: 1 };
  if (!success) return unknown;
  let cost: number | undefined;
  if (kind === 'model') {
    const configured = model ? rates.models[model] : undefined;
    // Total tokens lets us include reasoning output without guessing an omitted count.
    if (!configured || value.inputTokens === undefined || value.outputTokens === undefined || value.totalTokens === undefined) return unknown;
    const tokenFields = [value.inputTokens, value.outputTokens, value.totalTokens, value.cachedInputTokens, value.thoughtTokens, value.toolUseInputTokens];
    if (tokenFields.some(count => count !== undefined && (!Number.isSafeInteger(count) || count < 0))) return unknown;
    if ((value.cachedInputTokens ?? 0) > value.inputTokens || value.totalTokens < value.inputTokens + value.outputTokens + (value.thoughtTokens ?? 0) + (value.toolUseInputTokens ?? 0)) return unknown;
    if ((value.toolUseInputTokens ?? 0) > 0) return unknown; // tool-use tariff is intentionally not guessed
    const cached = value.cachedInputTokens ?? 0;
    const output = Math.max(value.outputTokens + (value.thoughtTokens ?? 0), value.totalTokens - value.inputTokens);
    if (cached && configured.cachedInputPerMillion === undefined) return unknown;
    cost = ((value.inputTokens - cached) * configured.inputPerMillion + cached * (configured.cachedInputPerMillion ?? configured.inputPerMillion) + output * configured.outputPerMillion) / 1000000;
  } else if (kind === 'speech' && rates.speechPerMillionCharacters !== undefined) cost = units * rates.speechPerMillionCharacters / 1000000;
  else if (kind === 'transcription' && rates.transcriptionPerHour !== undefined && value.audioMs !== undefined) cost = value.audioMs * rates.transcriptionPerHour / 3600000;
  else if (kind === 'ingestion' && rates.ingestionPerGiB !== undefined) cost = units * rates.ingestionPerGiB / 1073741824;
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return unknown;
  return { estimatedUsd: cost, pricedRequests: 1, priceDates: [rates.effectiveDate] };
}
