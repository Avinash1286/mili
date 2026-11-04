import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { authorize, byId, fail, service, session } from './guards.js';
import { emptyUsage, sumObservation, usageKinds, usageLabels, usagePolicy, type UsageKind, type UsageObservation, type UsageTotals } from '../packages/contracts/src/usage.js';

const daily = (ctx: any, scope: string, day: string, kind: string) => ctx.db.query('usageDays').withIndex('by_scope_day_kind', (q: any) => q.eq('scope', scope).eq('day', day).eq('kind', kind)).unique();
const kindOf = (value: string): UsageKind => { if (!usageKinds.includes(value as UsageKind)) fail('INVALID_USAGE', 400, 'Unknown work category.'); return value as UsageKind; };
const active = (ctx: any, kind: string, now: number) => ctx.db.query('usageReservations').withIndex('by_kind_state_expiry', (q: any) => q.eq('kind', kind).eq('state', 'running').gt('expiresAt', now)).take(17);
const id = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(value)) fail('INVALID_USAGE', 400, 'Invalid work identifier.'); };

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
    for (const key of ['units', 'requests', 'succeeded', 'failed'] as const) totals[key] += row.totals[key];
    await ctx.db.patch(existing._id, { totals }); await ctx.db.delete(row._id);
  }
  for (const row of reservations) {
    // The already-running API request still knows its guest owner. Only that service-side
    // settlement may use this alias; admission and all reads use the new account owner.
    await ctx.db.patch(row._id, { ownerId: userId, ...(row.state === 'running' ? { settlementOwnerId: guestId } : {}) });
  }
}

/** Both owner and global admission commit atomically, across every API instance. */
export const reserve = mutation({ args: { principal: v.any(), id: v.string(), kind: v.string(), units: v.number(), sessionId: v.optional(v.string()), traceId: v.optional(v.string()) }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal); id(args.id); if (args.traceId) id(args.traceId);
  if (args.sessionId) await session(ctx, owner.id, args.sessionId);
  const kind = kindOf(args.kind), policy = usagePolicy(kind, process.env), now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  if (!Number.isSafeInteger(args.units) || args.units < 1) fail('INVALID_USAGE', 400, 'Work requires a bounded positive unit reservation.');
  if (await byId(ctx, 'usageReservations', args.id)) fail('USAGE_REPLAY', 409, 'This work reservation was already used.');
  const leases = await active(ctx, kind, now);
  if (leases.length >= policy.globalConcurrent || leases.filter((item: any) => item.ownerId === owner.id).length >= policy.ownerConcurrent) fail('WORK_CAPACITY', 429, 'This work is already running or capacity is full. Wait briefly, then retry.');
  const scopes: [string, number][] = [['global', policy.globalDaily], [`owner:${owner.id}`, policy.ownerDaily]];
  if (args.sessionId) scopes.push([`session:${owner.id}/${args.sessionId}`, policy.ownerDaily]);
  for (const [scope, limit] of scopes) {
    const row = await daily(ctx, scope, day, kind), totals: UsageTotals = row?.totals ?? emptyUsage();
    if (totals.units + args.units > limit) fail('DAILY_USAGE_LIMIT', 429, 'The daily generation allowance has been reached. Saved lessons, text samples and exports remain available. Allowances reset at midnight UTC.');
    const next = { ...totals, units: totals.units + args.units, requests: totals.requests + 1 };
    if (row) await ctx.db.patch(row._id, { totals: next }); else await ctx.db.insert('usageDays', { scope, day, kind, totals: next });
  }
  await ctx.db.insert('usageReservations', { id: args.id, ownerId: owner.id, day, kind, units: args.units, state: 'running', startedAt: now, expiresAt: now + policy.leaseMs, ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.traceId ? { traceId: args.traceId } : {}) });
  return { id: args.id, expiresAt: now + policy.leaseMs };
} });
/** Unknown failures retain their reservation: a timeout is not evidence that the provider did no billed work. */
export const finish = mutation({ args: { id: v.string(), ownerId: v.string(), success: v.boolean(), usedUnits: v.optional(v.number()), observation: v.any() }, handler: async (ctx, args) => {
  await service(ctx); const row = await byId(ctx, 'usageReservations', args.id); if (!row || row.ownerId !== args.ownerId && row.settlementOwnerId !== args.ownerId || row.state !== 'running') return null;
  const used = args.success && args.usedUnits !== undefined ? Math.max(0, Math.min(row.units, Math.ceil(args.usedUnits))) : row.units;
  if (!Number.isFinite(used)) fail('INVALID_USAGE', 400, 'Invalid usage measurement.');
  const observation: UsageObservation = args.observation && typeof args.observation === 'object' ? args.observation : {};
  for (const scope of ['global', `owner:${row.ownerId}`, ...(row.sessionId ? [`session:${row.ownerId}/${row.sessionId}`] : [])]) {
    const entry = await daily(ctx, scope, row.day, row.kind); if (!entry) continue;
    const totals = sumObservation(entry.totals, observation);
    totals.units = Math.max(0, totals.units - row.units + used); totals[args.success ? 'succeeded' : 'failed']++;
    await ctx.db.patch(entry._id, { totals });
  }
  await ctx.db.patch(row._id, { state: args.success ? 'completed' : 'failed', units: used, settlementOwnerId: undefined, expiresAt: Date.now() });
  return null;
} });
export const summary = query({ args: { principal: v.any(), sessionId: v.optional(v.string()) }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal), now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  if (args.sessionId) await session(ctx, owner.id, args.sessionId);
  return { day, resetsAt: new Date(Date.parse(day) + 86400000).toISOString(), kinds: await Promise.all(usageKinds.map(async kind => {
    const row = await daily(ctx, args.sessionId ? `session:${owner.id}/${args.sessionId}` : `owner:${owner.id}`, day, kind), totals: UsageTotals = row?.totals ?? emptyUsage(), policy = usagePolicy(kind, process.env);
    const ownerUnits = args.sessionId ? (await daily(ctx, `owner:${owner.id}`, day, kind))?.totals.units ?? 0 : totals.units;
    return { kind, label: usageLabels[kind], limit: policy.ownerDaily, used: totals.units, remaining: Math.max(0, policy.ownerDaily - ownerUnits), active: (await active(ctx, kind, now)).filter((item: any) => item.ownerId === owner.id && (!args.sessionId || item.sessionId === args.sessionId)).length, totals };
  })) };
} });
