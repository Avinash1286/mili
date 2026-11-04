import { z } from './zod-runtime';

export const UsageKindSchema = z.enum(['model', 'speech', 'transcription', 'ingestion', 'storage', 'egress']);
export type UsageKind = z.infer<typeof UsageKindSchema>;
export type UsagePolicy = { ownerDaily: number; globalDaily: number; ownerConcurrent: number; globalConcurrent: number; leaseMs: number };
export type UsageTotals = { units: number; requests: number; succeeded: number; failed: number; budgetUsedMicros?: number; unboundedRequests?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; thoughtTokens?: number; toolUseInputTokens?: number; totalTokens?: number; audioMs?: number; durationMs?: number; storageBytesWritten?: number; egressBytesPrepared?: number; estimatedUsd?: number; pricedRequests?: number; unpricedRequests?: number; priceDates?: string[]; models?: string[] };
export type UsageObservation = Omit<UsageTotals, 'units' | 'requests' | 'succeeded' | 'failed' | 'budgetUsedMicros' | 'unboundedRequests'>;
export const usageKinds: UsageKind[] = ['model', 'speech', 'transcription', 'ingestion', 'storage', 'egress'];
export const usageLabels: Record<UsageKind, string> = { model: 'Model requests', speech: 'Speech characters', transcription: 'Transcription milliseconds', ingestion: 'Source bytes processed', storage: 'Storage bytes written', egress: 'Download bytes prepared' };
const defaults: Record<UsageKind, UsagePolicy> = {
  model: { ownerDaily: 100, globalDaily: 400, ownerConcurrent: 1, globalConcurrent: 4, leaseMs: 90000 },
  speech: { ownerDaily: 30000, globalDaily: 120000, ownerConcurrent: 1, globalConcurrent: 4, leaseMs: 150000 },
  transcription: { ownerDaily: 1800000, globalDaily: 7200000, ownerConcurrent: 1, globalConcurrent: 4, leaseMs: 300000 },
  ingestion: { ownerDaily: 50 * 1024 * 1024, globalDaily: 200 * 1024 * 1024, ownerConcurrent: 1, globalConcurrent: 2, leaseMs: 150000 },
  storage: { ownerDaily: 100 * 1024 * 1024, globalDaily: 400 * 1024 * 1024, ownerConcurrent: 4, globalConcurrent: 16, leaseMs: 300000 },
  egress: { ownerDaily: 500 * 1024 * 1024, globalDaily: 2000 * 1024 * 1024, ownerConcurrent: 4, globalConcurrent: 16, leaseMs: 300000 },
};
/** Deployment-side settings; absent values have conservative request/unit caps, not guessed prices. */
export function usagePolicy(kind: UsageKind, env: Record<string, string | undefined>): UsagePolicy {
  const base = defaults[kind], prefix = `TOKAI_${kind.toUpperCase()}`;
  function setting(suffix: string, fallback: number, maximum: number) {
    const value = env[`${prefix}_${suffix}`]; if (value === undefined) return fallback;
    const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`Invalid usage setting: ${prefix}_${suffix}`); return parsed;
  }
  return { ...base, ownerDaily: setting('DAILY_UNITS', base.ownerDaily, base.ownerDaily * 100), globalDaily: setting('GLOBAL_DAILY_UNITS', base.globalDaily, base.globalDaily * 100),
    ownerConcurrent: setting('CONCURRENCY', base.ownerConcurrent, 4), globalConcurrent: setting('GLOBAL_CONCURRENCY', base.globalConcurrent, 16) };
}
export const emptyUsage = (): UsageTotals => ({ units: 0, requests: 0, succeeded: 0, failed: 0 });
export const unboundedUsage = (totals: UsageTotals) => totals.unboundedRequests ?? (totals.budgetUsedMicros === undefined && totals.units > 0 ? totals.requests : 0);
export function sumObservation(totals: UsageTotals, observation: UsageObservation): UsageTotals {
  const next = { ...totals };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'thoughtTokens', 'toolUseInputTokens', 'totalTokens', 'audioMs', 'durationMs', 'storageBytesWritten', 'egressBytesPrepared', 'estimatedUsd', 'pricedRequests', 'unpricedRequests'] as const) {
    const value = observation[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[key] = (next[key] ?? 0) + value;
  }
  if (Array.isArray(observation.priceDates)) next.priceDates = [...new Set([...(next.priceDates ?? []), ...observation.priceDates.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))])].sort().slice(-100);
  if (Array.isArray(observation.models)) next.models = [...new Set([...(next.models ?? []), ...observation.models.filter(value => typeof value === 'string' && /^[\w./-]{1,200}$/.test(value))])].slice(0, 20);
  return next;
}
export type UsageBudgetSummary = { enabled: boolean; ownerLimitUsd?: number; globalLimitUsd?: number; ownerUsedUsd: number; globalUsedUsd: number; ownerRemainingUsd?: number; globalRemainingUsd?: number; basis: 'conservative-reservations' };
export type UsageSummary = { day: string; resetsAt: string; kinds: { kind: UsageKind; label: string; limit: number; used: number; remaining: number; active: number; totals: UsageTotals }[]; budget?: UsageBudgetSummary; storage?: { bytes: number; objects: number }; pricing: 'not-configured' | 'configured'; estimatedUsd?: number; priceDate?: string; note: string };
export * from './usage-pricing';
