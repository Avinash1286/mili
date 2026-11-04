import { z } from './zod-runtime';

export const UsageKindSchema = z.enum(['model', 'speech', 'transcription', 'ingestion']);
export type UsageKind = z.infer<typeof UsageKindSchema>;
export type UsagePolicy = { ownerDaily: number; globalDaily: number; ownerConcurrent: number; globalConcurrent: number; leaseMs: number };
export type UsageTotals = { units: number; requests: number; succeeded: number; failed: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; thoughtTokens?: number; toolUseInputTokens?: number; totalTokens?: number; audioMs?: number; durationMs?: number; estimatedUsd?: number; pricedRequests?: number; unpricedRequests?: number; priceDates?: string[] };
export type UsageObservation = Omit<UsageTotals, 'units' | 'requests' | 'succeeded' | 'failed'>;
export const usageKinds: UsageKind[] = ['model', 'speech', 'transcription', 'ingestion'];
export const usageLabels: Record<UsageKind, string> = { model: 'Model requests', speech: 'Speech characters', transcription: 'Transcription milliseconds', ingestion: 'Source bytes processed' };
const defaults: Record<UsageKind, UsagePolicy> = {
  model: { ownerDaily: 100, globalDaily: 400, ownerConcurrent: 1, globalConcurrent: 4, leaseMs: 90000 },
  speech: { ownerDaily: 30000, globalDaily: 120000, ownerConcurrent: 1, globalConcurrent: 4, leaseMs: 150000 },
  transcription: { ownerDaily: 1800000, globalDaily: 7200000, ownerConcurrent: 1, globalConcurrent: 4, leaseMs: 300000 },
  ingestion: { ownerDaily: 50 * 1024 * 1024, globalDaily: 200 * 1024 * 1024, ownerConcurrent: 1, globalConcurrent: 2, leaseMs: 150000 },
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
export function sumObservation(totals: UsageTotals, observation: UsageObservation): UsageTotals {
  const next = { ...totals };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'thoughtTokens', 'toolUseInputTokens', 'totalTokens', 'audioMs', 'durationMs', 'estimatedUsd', 'pricedRequests', 'unpricedRequests'] as const) {
    const value = observation[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[key] = (next[key] ?? 0) + value;
  }
  if (Array.isArray(observation.priceDates)) next.priceDates = [...new Set([...(next.priceDates ?? []), ...observation.priceDates.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))])].sort().slice(-100);
  return next;
}
export type UsageSummary = { day: string; resetsAt: string; kinds: { kind: UsageKind; label: string; limit: number; used: number; remaining: number; active: number; totals: UsageTotals }[]; pricing: 'not-configured' | 'configured'; estimatedUsd?: number; priceDate?: string; note: string };
