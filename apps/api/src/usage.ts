import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ConvexStore, StoreError, type Principal, type Store } from '@tokai/db';
import { emptyUsage, unboundedUsage, sumObservation, usageKinds, usageLabels, usagePolicy, budgetPolicy, hasBudget, priceUpperBound, usdMicros, summarizeBudget, storageRetentionDays, type VerifiedModelLimit, type UsageKind, type UsageObservation, type UsageSummary, type UsageTotals } from '@tokai/contracts';
import { priceUsage, usageRates, type UsageRates } from './usage-pricing.js';
import { lookupModelLimits } from './model-limits.js';

type Reservation = { id: string; ownerId: string; sessionId?: string; kind: UsageKind; units: number; day: string; expiresAt: number; state: 'running' | 'completed' | 'failed'; budgetMicros?: number };
type SummaryData = Pick<UsageSummary, 'day' | 'resetsAt' | 'kinds' | 'budget' | 'storage'>;
type MemoryState = { days: Map<string, UsageTotals>; reservations: Map<string, Reservation> };
const isolated = new WeakMap<Store, MemoryState>();
type Trace = { sessionId?: string; traceId?: string; model?: string; signal?: AbortSignal };
export type UsageLease = { id: string; expiresAt: number; finish: (success: boolean, usedUnits?: number, observation?: UsageObservation) => Promise<void> };
export type UsageReporter = (value: UsageObservation & { provider?: string; model?: string; requestId?: string }) => void;

/** Convex is authoritative in the full app. Memory is explicitly limited to isolated FileStore compatibility/tests. */
export class UsageMeter {
  private rates: UsageRates | undefined;
  private modelLimits?: VerifiedModelLimit;
  constructor(private store: Store, private env: Record<string, string | undefined>, private now: () => number = Date.now, private modelLookup = (model: string, signal?: AbortSignal) => lookupModelLimits(model, env.GEMINI_API_KEY, signal)) {
    this.rates = usageRates(env.TOKAI_USAGE_RATES_JSON);
    budgetPolicy(env); storageRetentionDays(env);
    for (const kind of usageKinds) usagePolicy(kind, env);
    if (!(store instanceof ConvexStore) && !isolated.has(store)) isolated.set(store, { days: new Map(), reservations: new Map() });
  }
  async begin(p: Principal, kind: UsageKind, units: number, trace: Trace = {}): Promise<UsageLease> {
    const id = randomUUID(), started = this.now();
    const model = trace.model ?? this.env.GEMINI_MODEL;
    const cleanTrace = { sessionId: trace.sessionId, traceId: trace.traceId };
    const getLimit = async () => {
      if (!model) throw new StoreError(503, 'USD_BOUND_UNAVAILABLE', 'The configured model is required for dollar admission.');
      if (!this.modelLimits || this.modelLimits.model !== model.replace(/^models\//, '') || this.now() - this.modelLimits.verifiedAt > 240000) this.modelLimits = await this.modelLookup(model, trace.signal);
      return this.modelLimits;
    };
    let reservation: { id: string; expiresAt: number };
    if (this.store instanceof ConvexStore) {
      const args = { principal: p, id, kind, units, ...cleanTrace, ...(model && kind === 'model' ? { model } : {}) };
      try { reservation = await this.store.transport.call('mutation', 'usage:reserve', args); }
      catch (error) {
        if (!(error instanceof StoreError) || error.code !== 'MODEL_BOUND_REQUIRED') throw error;
        reservation = await this.store.transport.call('mutation', 'usage:reserve', { ...args, modelLimit: await getLimit() });
      }
    } else reservation = await this.reserveMemory(p, id, kind, units, cleanTrace, model, kind === 'model' && hasBudget(budgetPolicy(this.env)) ? await getLimit() : undefined);
    let completed = false;
    return { ...reservation, finish: async (success, usedUnits, observation = {}) => {
      if (completed) return; completed = true;
      const noProviderWork = success && usedUnits === 0 && Object.keys(observation).every(key => key === 'durationMs');
      const pricing = this.rates && !noProviderWork ? kind !== 'model' ? priceUsage(this.rates, kind, observation, usedUnits ?? units, success, undefined, storageRetentionDays(this.env)) : observation.pricedRequests === undefined && observation.unpricedRequests === undefined ? { unpricedRequests: 1 } : {} : {};
      const measured = { ...observation, ...pricing, durationMs: Math.max(0, this.now() - started) };
      try {
        if (this.store instanceof ConvexStore) await this.store.transport.call('mutation', 'usage:finish', { id, ownerId: p.ownerId, success, usedUnits, observation: measured });
        else this.finishMemory(id, p.ownerId, success, usedUnits, measured);
        this.log({ event: 'work.completed', workId: id, kind, success, ...cleanTrace, durationMs: measured.durationMs, ...observation });
      } catch { this.log({ event: 'work.settlement_unavailable', workId: id, kind, ...cleanTrace }); }
    } };
  }
  async run<T>(p: Principal, kind: UsageKind, units: number, work: (observe: UsageReporter) => Promise<T>, options: Trace & { usedUnits?: (value: T) => number } = {}): Promise<T> {
    const lease = await this.begin(p, kind, units, { sessionId: options.sessionId, traceId: options.traceId, model: options.model, signal: options.signal });
    let observed: UsageTotals = emptyUsage(), calls = 0;
    const observe: UsageReporter = value => {
      observed = sumObservation(observed, value);
      if (value.model) observed = sumObservation(observed, { models: [value.model] });
      if (this.rates && kind === 'model') observed = sumObservation(observed, priceUsage(this.rates, kind, value, 1, true, value.model));
      if (value.provider) calls++;
      this.log({ event: 'provider.usage', workId: lease.id, kind, provider: value.provider, model: value.model?.slice(0, 100), requestId: value.requestId?.slice(0, 200), ...this.observation(value) });
    };
    try {
      const result = await work(observe);
      await lease.finish(true, options.usedUnits?.(result) ?? (kind === 'model' && calls > 0 ? calls : units), this.observation(observed)); return result;
    } catch (error) { await lease.finish(false, undefined, this.observation(observed)); throw error; }
  }
  async summary(p: Principal, sessionId?: string): Promise<UsageSummary> {
    if (sessionId) await this.store.get(p, sessionId);
    const data = this.store instanceof ConvexStore ? await this.store.transport.call<SummaryData>('query', 'usage:summary', { principal: p, sessionId }) : await this.summaryMemory(p, sessionId);
    const totals = data.kinds.map(item => item.totals), priced = totals.reduce((sum, item) => sum + (item.pricedRequests ?? 0), 0);
    const dates = [...new Set(totals.flatMap(item => item.priceDates ?? []))].sort();
    return { ...data, pricing: this.rates || priced ? 'configured' : 'not-configured', ...(priced ? { estimatedUsd: totals.reduce((sum, item) => sum + (item.estimatedUsd ?? 0), 0), priceDate: dates.join(', ') } : {}), note: 'Application allowances and configured dollar commitments are not provider credits or invoices. Estimates use dated rates; storage reserves its full bounded retention horizon and download counts describe bytes prepared, not confirmed receipt. Unknown work, provider minimums and taxes can differ from estimates. Failed or unmeasured work retains its bound. Saved content remains accessible; metered file transfers require available allowance.' };
  }
  private observation(value: UsageObservation): UsageObservation {
    const result: UsageObservation = {};
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'thoughtTokens', 'toolUseInputTokens', 'totalTokens', 'audioMs', 'durationMs', 'storageBytesWritten', 'egressBytesPrepared', 'estimatedUsd', 'pricedRequests', 'unpricedRequests'] as const) if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key]! >= 0) result[key] = value[key];
    if (value.priceDates) result.priceDates = value.priceDates;
    if (value.models) result.models = value.models;
    return result;
  }
  private log(record: Record<string, unknown>) { if (this.env.TOKAI_LOG_METRICS === '1') console.info(JSON.stringify({ component: 'tokai.usage', ...record })); }
  private async reserveMemory(p: Principal, id: string, kind: UsageKind, units: number, trace: Trace, model?: string, modelLimit?: VerifiedModelLimit) {
    await this.store.principalForOwner(p.ownerId); this.store.assertPrincipal(p); if (trace.sessionId) await this.store.get(p, trace.sessionId);
    if (!Number.isSafeInteger(units) || units < 1) throw new StoreError(400, 'INVALID_USAGE', 'Work requires positive bounded units.');
    const state = isolated.get(this.store)!, now = this.now(), day = new Date(now).toISOString().slice(0, 10), policy = usagePolicy(kind, this.env);
    for (const [key, lease] of state.reservations) if (lease.expiresAt < now - 86400000) state.reservations.delete(key);
    const active = [...state.reservations.values()].filter(lease => lease.kind === kind && lease.state === 'running' && lease.expiresAt > now);
    if (active.length >= policy.globalConcurrent || active.filter(lease => lease.ownerId === p.ownerId).length >= policy.ownerConcurrent) throw new StoreError(429, 'WORK_CAPACITY', 'This work is already running or capacity is full. Wait briefly, then retry.');
    const scopes: [string, number][] = [['global', policy.globalDaily], [`owner:${p.ownerId}`, policy.ownerDaily]];
    if (trace.sessionId) scopes.push([`session:${p.ownerId}/${trace.sessionId}`, policy.ownerDaily]);
    const budget = budgetPolicy(this.env), bound = priceUpperBound(this.rates, kind, units, { now, model, modelLimit, retentionDays: storageRetentionDays(this.env) });
    if (hasBudget(budget)) {
      if (bound === undefined) throw new StoreError(503, 'USD_BOUND_UNAVAILABLE', 'Dated rates and verified limits are required before dollar-capped work.');
      for (const [scope, limit] of [['global', budget.globalMicros], [`owner:${p.ownerId}`, budget.ownerMicros]] as const) {
        const rows = usageKinds.map(category => state.days.get(`${scope}:${day}:${category}`));
        if (limit !== undefined && rows.some(row => row && unboundedUsage(row) > 0)) throw new StoreError(503, 'USD_HISTORY_CONFIGURATION', 'Earlier work today has no cost bound. Wait for the next UTC reset.');
        if (limit !== undefined && rows.reduce((total, row) => total + (row?.budgetUsedMicros ?? 0), 0) + bound > limit) throw new StoreError(429, 'DAILY_USD_LIMIT', 'The configured daily dollar commitment has been reached.');
      }
    }
    for (const [scope, limit] of scopes) if ((state.days.get(`${scope}:${day}:${kind}`)?.units ?? 0) + units > limit) throw new StoreError(429, 'DAILY_USAGE_LIMIT', 'The daily generation allowance has been reached. Saved work and samples remain available; allowances reset at midnight UTC.');
    for (const [scope] of scopes) { const key = `${scope}:${day}:${kind}`, old = state.days.get(key) ?? emptyUsage(); state.days.set(key, { ...old, units: old.units + units, requests: old.requests + 1, unboundedRequests: unboundedUsage(old) + (bound === undefined ? 1 : 0), ...(bound === undefined ? {} : { budgetUsedMicros: (old.budgetUsedMicros ?? 0) + bound }) }); }
    const reservation: Reservation = { id, ownerId: p.ownerId, sessionId: trace.sessionId, kind, units, day, state: 'running', expiresAt: now + policy.leaseMs, ...(bound === undefined ? {} : { budgetMicros: bound }) }; state.reservations.set(id, reservation); return { id, expiresAt: reservation.expiresAt };
  }
  private finishMemory(id: string, ownerId: string, success: boolean, usedUnits: number | undefined, observation: UsageObservation) {
    const state = isolated.get(this.store)!, lease = state.reservations.get(id); if (!lease || lease.ownerId !== ownerId || lease.state !== 'running') return;
    const used = success && usedUnits !== undefined && Number.isFinite(usedUnits) ? Math.max(0, Math.min(lease.units, Math.ceil(usedUnits))) : lease.units;
    for (const scope of ['global', `owner:${ownerId}`, ...(lease.sessionId ? [`session:${ownerId}/${lease.sessionId}`] : [])]) {
      const key = `${scope}:${lease.day}:${lease.kind}`, old = state.days.get(key); if (!old) continue;
      const next = sumObservation(old, observation); next.units = Math.max(0, old.units - lease.units + used); next[success ? 'succeeded' : 'failed']++; state.days.set(key, next);
      if (lease.budgetMicros === undefined && success && used === 0) next.unboundedRequests = Math.max(0, unboundedUsage(old) - 1);
      if (lease.budgetMicros !== undefined) next.budgetUsedMicros = Math.max(0, (old.budgetUsedMicros ?? 0) - lease.budgetMicros + (success && observation.estimatedUsd !== undefined && !observation.unpricedRequests ? usdMicros(observation.estimatedUsd) : success && used === 0 ? 0 : lease.budgetMicros));
    }
    lease.state = success ? 'completed' : 'failed'; lease.units = used; lease.expiresAt = this.now();
  }
  private async summaryMemory(p: Principal, sessionId?: string): Promise<SummaryData> {
    this.store.assertPrincipal(p); await this.store.principalForOwner(p.ownerId);
    const state = isolated.get(this.store)!, now = this.now(), day = new Date(now).toISOString().slice(0, 10);
    const spent = (scope: string) => usageKinds.reduce((sum, kind) => sum + (state.days.get(`${scope}:${day}:${kind}`)?.budgetUsedMicros ?? 0), 0);
    return { day, resetsAt: new Date(Date.parse(day) + 86400000).toISOString(), budget: summarizeBudget(budgetPolicy(this.env), spent(`owner:${p.ownerId}`), spent('global')), kinds: usageKinds.map(kind => {
      const totals = state.days.get(`${sessionId ? `session:${p.ownerId}/${sessionId}` : `owner:${p.ownerId}`}:${day}:${kind}`) ?? emptyUsage(), limit = usagePolicy(kind, this.env).ownerDaily;
      const ownerUnits = sessionId ? state.days.get(`owner:${p.ownerId}:${day}:${kind}`)?.units ?? 0 : totals.units;
      return { kind, label: usageLabels[kind], limit, used: totals.units, remaining: Math.max(0, limit - ownerUnits), active: [...state.reservations.values()].filter(lease => lease.ownerId === p.ownerId && lease.kind === kind && (!sessionId || lease.sessionId === sessionId) && lease.state === 'running' && lease.expiresAt > now).length, totals };
    }) };
  }
}
export function registerUsage(app: FastifyInstance, store: Store, usage: UsageMeter) {
  app.get('/v1/me/usage', async request => usage.summary(await store.authenticate(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined)));
  app.get<{ Params: { id: string } }>('/v1/sessions/:id/usage', async request => usage.summary(await store.authenticate(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined), request.params.id));
}
