import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { activeOwner, authorize, byId, fail, service, session } from './guards.js';
import { emptyUsage, unboundedUsage, sumObservation, usageKinds, usageLabels, usagePolicy, budgetPolicy, hasBudget, usageRates, priceUpperBound, priceUsage, usdMicros, storageRetentionDays, summarizeBudget, type VerifiedModelLimit, type UsageKind, type UsageObservation, type UsageTotals } from '../packages/contracts/src/usage.js';

const daily = (ctx: any, scope: string, day: string, kind: string) => ctx.db.query('usageDays').withIndex('by_scope_day_kind', (q: any) => q.eq('scope', scope).eq('day', day).eq('kind', kind)).unique();
const kindOf = (value: string): UsageKind => { if (!usageKinds.includes(value as UsageKind)) fail('INVALID_USAGE', 400, 'Unknown work category.'); return value as UsageKind; };
const active = (ctx: any, kind: string, now: number) => ctx.db.query('usageReservations').withIndex('by_kind_state_expiry', (q: any) => q.eq('kind', kind).eq('state', 'running').gt('expiresAt', now)).take(17);
const id = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(value)) fail('INVALID_USAGE', 400, 'Invalid work identifier.'); };
const inventory = (ctx: any, ownerId: string) => ctx.db.query('usageStorage').withIndex('by_owner', (q: any) => q.eq('ownerId', ownerId)).unique();
export async function updateStorageInventory(ctx: any, ownerId: string, bytesDelta: number, objectsDelta: number) {
  if (!Number.isSafeInteger(bytesDelta) || !Number.isSafeInteger(objectsDelta)) fail('INVALID_USAGE', 400, 'Invalid storage measurement.');
  for (const scope of [ownerId, 'global']) {
    const old = await inventory(ctx, scope), value = { ownerId: scope, bytes: Math.max(0, (old?.bytes ?? 0) + bytesDelta), objects: Math.max(0, (old?.objects ?? 0) + objectsDelta), updatedAt: Date.now() };
    if (old) await ctx.db.patch(old._id, value); else await ctx.db.insert('usageStorage', value);
  }
}
async function budgetSpent(ctx: any, scope: string, day: string, strict = false): Promise<number> {
  const rows = await Promise.all(usageKinds.map(kind => daily(ctx, scope, day, kind)));
  if (strict && rows.some(row => row && unboundedUsage(row.totals) > 0)) fail('USD_HISTORY_CONFIGURATION', 503, 'Earlier work today has no verified cost bound. Dollar admission can begin after the next UTC reset.');
  return rows.reduce((total, row) => total + (row?.totals.budgetUsedMicros ?? 0), 0);
}

/** Runs inside the same identity mutation as lesson transfer; global spend is never moved or counted again. */
export async function claimUsage(ctx: any, guestId: string, userId: string) {
  const prefix = `session:${guestId}/`;
  const [ownerRows, sessionRows, reservations] = await Promise.all([
    ctx.db.query('usageDays').withIndex('by_scope_day_kind', (q: any) => q.eq('scope', `owner:${guestId}`)).take(5000),
    ctx.db.query('usageDays').withIndex('by_scope_day_kind', (q: any) => q.gte('scope', prefix).lt('scope', `${prefix}\uffff`)).take(5000),
    ctx.db.query('usageReservations').withIndex('by_owner', (q: any) => q.eq('ownerId', guestId)).take(5000),
  ]);
  if ([ownerRows, sessionRows, reservations].some(rows => rows.length >= 5000)) fail('CLAIM_TOO_LARGE', 409, 'This guest needs a background transfer before it can be claimed.');
  for (const row of [...ownerRows, ...sessionRows]) {
    const scope = row.scope === `owner:${guestId}` ? `owner:${userId}` : `session:${userId}/${row.scope.slice(prefix.length)}`;
    const existing = await daily(ctx, scope, row.day, row.kind);
    if (!existing) { await ctx.db.patch(row._id, { scope }); continue; }
    const totals = sumObservation(existing.totals, row.totals);
    totals.unboundedRequests = unboundedUsage(existing.totals) + unboundedUsage(row.totals);
    for (const key of ['units', 'requests', 'succeeded', 'failed'] as const) totals[key] += row.totals[key];
    if (row.totals.budgetUsedMicros !== undefined || existing.totals.budgetUsedMicros !== undefined) totals.budgetUsedMicros = (row.totals.budgetUsedMicros ?? 0) + (existing.totals.budgetUsedMicros ?? 0);
    await ctx.db.patch(existing._id, { totals }); await ctx.db.delete(row._id);
  }
  for (const row of reservations) {
    // The already-running API request still knows its guest owner. Only that service-side
    // settlement may use this alias; admission and all reads use the new account owner.
    await ctx.db.patch(row._id, { ownerId: userId, ...(row.state === 'running' ? { settlementOwnerId: guestId } : {}) });
  }
  const files = await ctx.db.query('files').withIndex('by_owner', (q: any) => q.eq('ownerId', guestId)).take(5000);
  if (files.length >= 5000) fail('CLAIM_TOO_LARGE', 409, 'This guest needs a background transfer before it can be claimed.');
  for (const file of files) await ctx.db.patch(file._id, { ownerId: userId });
  const oldInventory = await inventory(ctx, guestId), newInventory = await inventory(ctx, userId);
  if (oldInventory) {
    if (newInventory) { await ctx.db.patch(newInventory._id, { bytes: newInventory.bytes + oldInventory.bytes, objects: newInventory.objects + oldInventory.objects, updatedAt: Date.now() }); await ctx.db.delete(oldInventory._id); }
    else await ctx.db.patch(oldInventory._id, { ownerId: userId, updatedAt: Date.now() });
  }
}

/** Both owner and global admission commit atomically, across every API instance. */
export type ReserveUsageInput = { ownerId: string; id: string; kind: string; units: number; sessionId?: string; traceId?: string; model?: string; modelLimit?: VerifiedModelLimit; retentionDays?: number };
export async function reserveUsage(ctx: any, args: ReserveUsageInput, env: Record<string, string | undefined> = process.env) {
  const owner = await activeOwner(ctx, args.ownerId); id(args.id); if (args.traceId && !/^[a-zA-Z0-9][a-zA-Z0-9:/._-]{0,499}$/.test(args.traceId)) fail('INVALID_USAGE', 400, 'Invalid work reference.');
  if (args.sessionId) await session(ctx, owner.id, args.sessionId);
  const kind = kindOf(args.kind), policy = usagePolicy(kind, env), budget = budgetPolicy(env), rates = usageRates(env.TOKAI_USAGE_RATES_JSON), now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const horizon = storageRetentionDays(env), retentionDays = kind === 'storage' && horizon !== undefined ? Math.min(horizon, Math.max(1, Math.min(365, args.retentionDays ?? 365))) : undefined;
  if (!Number.isSafeInteger(args.units) || args.units < 1) fail('INVALID_USAGE', 400, 'Work requires a bounded positive unit reservation.');
  if (await byId(ctx, 'usageReservations', args.id)) fail('USAGE_REPLAY', 409, 'This work reservation was already used.');
  const leases = await active(ctx, kind, now);
  if (leases.length >= policy.globalConcurrent || leases.filter((item: any) => item.ownerId === owner.id).length >= policy.ownerConcurrent) fail('WORK_CAPACITY', 429, 'This work is already running or capacity is full. Wait briefly, then retry.');
  const bound = priceUpperBound(rates, kind, args.units, { model: args.model, modelLimit: args.modelLimit, now, retentionDays });
  if (hasBudget(budget)) {
    if (bound === undefined) {
      if (kind === 'model' && rates && args.model && rates.models[args.model] && !args.modelLimit) fail('MODEL_BOUND_REQUIRED', 503, 'Verify model limits before starting this work.');
      fail('USD_BOUND_UNAVAILABLE', 503, 'Dollar admission requires dated rates and a verified upper bound for this work. Ask the operator to check budget configuration.');
    }
    for (const [scope, limit] of [['global', budget.globalMicros], [`owner:${owner.id}`, budget.ownerMicros]] as const) {
      if (limit !== undefined && await budgetSpent(ctx, scope, day, true) + bound > limit) fail('DAILY_USD_LIMIT', 429, 'The configured daily dollar commitment limit has been reached. Saved work remains available; try after the UTC reset.');
    }
  }
  const scopes: [string, number][] = [['global', policy.globalDaily], [`owner:${owner.id}`, policy.ownerDaily]];
  if (args.sessionId) scopes.push([`session:${owner.id}/${args.sessionId}`, policy.ownerDaily]);
  for (const [scope, limit] of scopes) {
    const row = await daily(ctx, scope, day, kind), totals: UsageTotals = row?.totals ?? emptyUsage();
    if (totals.units + args.units > limit) fail('DAILY_USAGE_LIMIT', 429, 'The daily generation allowance has been reached. Saved lessons, text samples and exports remain available. Allowances reset at midnight UTC.');
    const next = { ...totals, units: totals.units + args.units, requests: totals.requests + 1, unboundedRequests: unboundedUsage(totals) + (bound === undefined ? 1 : 0), ...(bound === undefined ? {} : { budgetUsedMicros: (totals.budgetUsedMicros ?? 0) + bound }) };
    if (row) await ctx.db.patch(row._id, { totals: next }); else await ctx.db.insert('usageDays', { scope, day, kind, totals: next });
  }
  const retentionUntil = retentionDays === undefined ? undefined : now + retentionDays * 86400000;
  await ctx.db.insert('usageReservations', { id: args.id, ownerId: owner.id, day, kind, units: args.units, state: 'running', startedAt: now, expiresAt: now + policy.leaseMs, ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.traceId ? { traceId: args.traceId } : {}), ...(bound === undefined ? {} : { budgetMicros: bound }), ...(rates ? { rates } : {}), ...(args.model ? { model: args.model } : {}), ...(retentionDays === undefined ? {} : { retentionDays, retentionUntil }) });
  return { id: args.id, expiresAt: now + policy.leaseMs, ...(retentionUntil === undefined ? {} : { retentionUntil }) };
}
export const reserve = mutation({ args: { principal: v.any(), id: v.string(), kind: v.string(), units: v.number(), sessionId: v.optional(v.string()), traceId: v.optional(v.string()), model: v.optional(v.string()), modelLimit: v.optional(v.any()) }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal); return reserveUsage(ctx, { ...args, ownerId: owner.id });
} });
/** Unknown failures retain their reservation: a timeout is not evidence that the provider did no billed work. */
export async function settleUsage(ctx: any, args: { id: string; ownerId: string; success: boolean; usedUnits?: number; observation?: UsageObservation }) {
  const row = await byId(ctx, 'usageReservations', args.id); if (!row || row.ownerId !== args.ownerId && row.settlementOwnerId !== args.ownerId || row.state !== 'running') return null;
  const used = args.success && args.usedUnits !== undefined ? Math.max(0, Math.min(row.units, Math.ceil(args.usedUnits))) : row.units;
  if (!Number.isFinite(used)) fail('INVALID_USAGE', 400, 'Invalid usage measurement.');
  let observation: UsageObservation = args.observation && typeof args.observation === 'object' ? { ...args.observation } : {};
  if (row.rates) {
    const modelMatches = row.kind !== 'model' || observation.models?.length && observation.models.every(model => model.replace(/^models\//, '') === row.model?.replace(/^models\//, ''));
    const priced = args.success && used === 0 ? { estimatedUsd: 0 } : modelMatches ? priceUsage(row.rates, row.kind, observation, used, args.success, row.model, row.retentionDays) : { unpricedRequests: 1 };
    const { estimatedUsd: _, pricedRequests: __, unpricedRequests: ___, priceDates: ____, ...measured } = observation;
    observation = { ...measured, ...priced };
  }
  const settledMicros = row.budgetMicros === undefined ? undefined : args.success && observation.estimatedUsd !== undefined && !observation.unpricedRequests ? usdMicros(observation.estimatedUsd) : row.budgetMicros;
  for (const scope of ['global', `owner:${row.ownerId}`, ...(row.sessionId ? [`session:${row.ownerId}/${row.sessionId}`] : [])]) {
    const entry = await daily(ctx, scope, row.day, row.kind); if (!entry) continue;
    const totals = sumObservation(entry.totals, observation);
    totals.units = Math.max(0, totals.units - row.units + used); totals[args.success ? 'succeeded' : 'failed']++;
    if (row.budgetMicros === undefined && args.success && used === 0) totals.unboundedRequests = Math.max(0, unboundedUsage(entry.totals) - 1);
    if (settledMicros !== undefined) totals.budgetUsedMicros = Math.max(0, (totals.budgetUsedMicros ?? 0) - row.budgetMicros + settledMicros);
    await ctx.db.patch(entry._id, { totals });
  }
  await ctx.db.patch(row._id, { state: args.success ? 'completed' : 'failed', units: used, settlementOwnerId: undefined, expiresAt: Date.now() });
  return null;
}
export const finish = mutation({ args: { id: v.string(), ownerId: v.string(), success: v.boolean(), usedUnits: v.optional(v.number()), observation: v.any() }, handler: async (ctx, args) => { await service(ctx); return settleUsage(ctx, args); } });
export const summary = query({ args: { principal: v.any(), sessionId: v.optional(v.string()) }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal), now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  if (args.sessionId) await session(ctx, owner.id, args.sessionId);
  const stock = await inventory(ctx, owner.id);
  return { day, resetsAt: new Date(Date.parse(day) + 86400000).toISOString(), budget: summarizeBudget(budgetPolicy(process.env), await budgetSpent(ctx, `owner:${owner.id}`, day), await budgetSpent(ctx, 'global', day)), storage: { bytes: stock?.bytes ?? 0, objects: stock?.objects ?? 0 }, kinds: await Promise.all(usageKinds.map(async kind => {
    const row = await daily(ctx, args.sessionId ? `session:${owner.id}/${args.sessionId}` : `owner:${owner.id}`, day, kind), totals: UsageTotals = row?.totals ?? emptyUsage(), policy = usagePolicy(kind, process.env);
    const ownerUnits = args.sessionId ? (await daily(ctx, `owner:${owner.id}`, day, kind))?.totals.units ?? 0 : totals.units;
    return { kind, label: usageLabels[kind], limit: policy.ownerDaily, used: totals.units, remaining: Math.max(0, policy.ownerDaily - ownerUnits), active: (await active(ctx, kind, now)).filter((item: any) => item.ownerId === owner.id && (!args.sessionId || item.sessionId === args.sessionId)).length, totals };
  })) };
} });
