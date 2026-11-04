import { z } from './zod-runtime';
import type { UsageKind, UsageObservation, UsageBudgetSummary } from './usage';

const rate = z.number().finite().min(0).max(1000000);
const RatesSchema = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value),
  models: z.record(z.string().min(1).max(200), z.object({ inputPerMillion: rate, outputPerMillion: rate, cachedInputPerMillion: rate.optional() }).strict()).default({}),
  speechPerMillionCharacters: rate.optional(), transcriptionPerHour: rate.optional(), ingestionPerGiB: rate.optional(),
  storagePerGiBDay: rate.optional(), egressPerGiB: rate.optional(),
}).strict();
export type UsageRates = z.infer<typeof RatesSchema>;
/** Operator-supplied, dated USD rates. No default prices or account billing assumptions. */
export function usageRates(raw: string | undefined): UsageRates | undefined {
  if (!raw) return undefined;
  try { return RatesSchema.parse(JSON.parse(raw)); } catch { throw new Error('TOKAI_USAGE_RATES_JSON must be a valid dated USD rate table.'); }
}
export function priceUsage(rates: UsageRates, kind: UsageKind, value: UsageObservation, units: number, success: boolean, model?: string, retentionDays?: number): UsageObservation {
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
  else if (kind === 'egress' && rates.egressPerGiB !== undefined) cost = units * rates.egressPerGiB / 1073741824;
  else if (kind === 'storage' && rates.storagePerGiBDay !== undefined && retentionDays !== undefined) cost = units * retentionDays * rates.storagePerGiBDay / 1073741824;
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return unknown;
  return { estimatedUsd: cost, pricedRequests: 1, priceDates: [rates.effectiveDate] };
}

export type VerifiedModelLimit = { model: string; inputTokenLimit: number; outputTokenLimit: number; verifiedAt: number };
export type BudgetPolicy = { ownerMicros?: number; globalMicros?: number };
export function budgetPolicy(env: Record<string, string | undefined>): BudgetPolicy {
  const read = (key: string) => {
    const value = env[key]; if (value === undefined || value === '') return undefined;
    if (!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(value)) throw new Error(`Invalid USD budget: ${key}`);
    const [whole, fraction = ''] = value.split('.'); const result = Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
    if (!Number.isSafeInteger(result)) throw new Error(`Invalid USD budget: ${key}`); return result;
  };
  return { ownerMicros: read('TOKAI_OWNER_DAILY_USD'), globalMicros: read('TOKAI_GLOBAL_DAILY_USD') };
}
export const hasBudget = (policy: BudgetPolicy) => policy.ownerMicros !== undefined || policy.globalMicros !== undefined;
export function usdMicros(value: number) { const result = Math.ceil(value * 1000000); if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid price bound.'); return result; }
export function storageRetentionDays(env: Record<string, string | undefined>): number | undefined {
  const raw = env.TOKAI_STORAGE_MAX_RETENTION_DAYS; if (raw === undefined || raw === '') return undefined;
  const days = Number(raw); if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('TOKAI_STORAGE_MAX_RETENTION_DAYS must be1..365.'); return days;
}
/** Full independently verified model capability, not a guess based on characters or an image. */
export function priceUpperBound(rates: UsageRates | undefined, kind: UsageKind, units: number, options: { model?: string; modelLimit?: VerifiedModelLimit; now: number; retentionDays?: number }): number | undefined {
  if (!rates) return undefined;
  if (kind === 'model') {
    const rate = options.model ? rates.models[options.model] : undefined, limits = options.modelLimit;
    if (!rate || !limits || limits.model !== options.model?.replace(/^models\//, '') || limits.verifiedAt > options.now + 1000 || options.now - limits.verifiedAt > 300000
      || !Number.isSafeInteger(limits.inputTokenLimit) || limits.inputTokenLimit < 1 || !Number.isSafeInteger(limits.outputTokenLimit) || limits.outputTokenLimit < 1) return undefined;
    return usdMicros(units * (limits.inputTokenLimit * Math.max(rate.inputPerMillion, rate.cachedInputPerMillion ?? rate.inputPerMillion) + limits.outputTokenLimit * rate.outputPerMillion) / 1000000);
  }
  const observed = kind === 'transcription' ? { audioMs: units } : {};
  const value = priceUsage(rates, kind, observed, units, true, undefined, options.retentionDays);
  return value.estimatedUsd === undefined ? undefined : usdMicros(value.estimatedUsd);
}
export function summarizeBudget(policy: BudgetPolicy, ownerMicros: number, globalMicros: number): UsageBudgetSummary {
  return { enabled: hasBudget(policy), basis: 'conservative-reservations', ownerUsedUsd: ownerMicros / 1000000, globalUsedUsd: globalMicros / 1000000,
    ...(policy.ownerMicros === undefined ? {} : { ownerLimitUsd: policy.ownerMicros / 1000000, ownerRemainingUsd: Math.max(0, policy.ownerMicros - ownerMicros) / 1000000 }),
    ...(policy.globalMicros === undefined ? {} : { globalLimitUsd: policy.globalMicros / 1000000, globalRemainingUsd: Math.max(0, policy.globalMicros - globalMicros) / 1000000 }) };
}
