import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { activeOwner, authorize, byId, fail, principal, service, session } from './guards.js';

export const issue = mutation({ args: { principal: v.any(), hash: v.string(), sessionId: v.string(), expiresAt: v.number() }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal), lesson = await session(ctx, owner.id, args.sessionId);
  if (args.principal.internal || !/^[a-f0-9]{64}$/.test(args.hash) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 60000 || args.expiresAt > Date.parse(args.principal.expiresAt)) fail('INVALID_TICKET', 400, 'Invalid voice ticket.');
  if (lesson.snapshot.mode !== 'live' || lesson.snapshot.status !== 'active') fail('LIVE_REQUIRED', 409, 'An active live lesson is required.');
  const old = await ctx.db.query('voiceTickets').withIndex('by_owner', q => q.eq('ownerId', owner.id)).take(100);
  for (const ticket of old) await ctx.db.delete(ticket._id);
  await ctx.db.insert('voiceTickets', { hash: args.hash, ownerId: owner.id, authSessionId: args.principal.authSessionId, sessionId: args.sessionId, sessionRevision: lesson.revision, expiresAt: args.expiresAt });
  // Bound expired-ticket retention even if the scheduled maintenance is delayed.
  for (const ticket of await ctx.db.query('voiceTickets').withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(20)) await ctx.db.delete(ticket._id);
} });

/** Returning a rejection (rather than throwing) commits consumption on a failed attempt. */
export const consume = mutation({ args: { hash: v.string(), leaseTtlMs: v.number() }, handler: async (ctx, args) => {
  await service(ctx);
  if (!/^[a-f0-9]{64}$/.test(args.hash) || !Number.isInteger(args.leaseTtlMs) || args.leaseTtlMs < 1000 || args.leaseTtlMs > 120000) fail('INVALID_TICKET', 400, 'Invalid voice ticket.');
  const ticket = await ctx.db.query('voiceTickets').withIndex('by_hash', q => q.eq('hash', args.hash)).unique();
  const invalid = { error: { status: 401, code: 'INVALID_TICKET', message: 'The voice ticket expired, changed or was already used.' } };
  if (!ticket) return invalid;
  await ctx.db.delete(ticket._id);
  if (ticket.expiresAt <= Date.now()) return invalid;
  let owner, lesson, auth;
  try {
    owner = await activeOwner(ctx, ticket.ownerId); auth = await byId(ctx, 'authSessions', ticket.authSessionId);
    if (!auth || auth.ownerId !== owner.id || auth.revokedAt !== undefined || auth.expiresAt <= Date.now()) return invalid;
    lesson = await session(ctx, owner.id, ticket.sessionId);
  } catch { return invalid; }
  if (lesson.revision !== ticket.sessionRevision || lesson.snapshot.mode !== 'live' || lesson.snapshot.status !== 'active') return invalid;
  const key = `voice:${owner.id}`, previous = await ctx.db.query('fences').withIndex('by_key', q => q.eq('key', key)).unique();
  if (previous && previous.expiresAt > Date.now()) return { error: { status: 409, code: 'VOICE_ACTIVE', message: 'An active connection already owns this lesson.' } };
  const fence = (previous?.fence ?? 0) + 1, value = { key, fence, expiresAt: Date.now() + args.leaseTtlMs };
  if (previous) await ctx.db.replace(previous._id, value); else await ctx.db.insert('fences', value);
  return { principal: principal(owner, auth), sessionId: ticket.sessionId, expiresAt: ticket.expiresAt, fence };
} });

export const revoke = mutation({ args: { ownerId: v.optional(v.string()), sessionId: v.optional(v.string()) }, handler: async (ctx, args) => {
  await service(ctx); if (!args.ownerId && !args.sessionId) fail('INVALID_SCOPE', 400, 'A ticket scope is required.');
  const rows = args.ownerId
    ? await ctx.db.query('voiceTickets').withIndex('by_owner', q => q.eq('ownerId', args.ownerId!)).take(100)
    : await ctx.db.query('voiceTickets').withIndex('by_session', q => q.eq('sessionId', args.sessionId!)).take(100);
  for (const row of rows) if (!args.sessionId || row.sessionId === args.sessionId) await ctx.db.delete(row._id);
} });
