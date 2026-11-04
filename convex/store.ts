import { makeFunctionReference } from 'convex/server';
import { internal } from './_generated/api';
import { query, mutation, internalQuery, internalMutation, action } from './_generated/server';
import { v } from 'convex/values';
import { activeOwner, authorize, bounded, byId, fail, principal as principalOf, publicResource, resource, service, session } from './guards.js';
import { claimUsage } from './usage.js';
const stamp = () => new Date().toISOString();
const jobRun = makeFunctionReference<'action'>('jobs:run');
const readRef = makeFunctionReference<'query'>('store:read');
const jobView = (item: any) => { const { _id, _creationTime, scheduledId, ...value } = item; return { ...value, availableAt: new Date(value.availableAt).toISOString(), ...(value.lockedUntil === undefined ? {} : { lockedUntil: new Date(value.lockedUntil).toISOString() }) }; };
const assertRevision = (actual: number, expected: number) => { if (actual !== expected) fail('REVISION_CONFLICT', 409, 'This item changed. Reload it and try again.'); };
async function schedule(ctx: any, item: any, at = item.availableAt) { const scheduledId = await ctx.scheduler.runAt(Math.max(Date.now(), at), jobRun, { jobId: item.id }); await ctx.db.patch(item._id, { scheduledId }); }
async function usableJob(ctx: any, item: any) {
  await activeOwner(ctx, item.ownerId); if (item.sessionId) await session(ctx, item.ownerId, item.sessionId);
  if (item.resourceId) await resource(ctx, item.ownerId, item.resourceKind, item.resourceId);
}
async function jobOwned(ctx: any, jobId: string, workerId: string, fence: number) {
  const item = await byId(ctx, 'jobs', jobId);
  if (!item || item.state !== 'running' || item.workerId !== workerId || item.fence !== fence || (item.lockedUntil ?? 0) <= Date.now()) fail('JOB_LEASE_LOST', 409, 'This worker no longer owns the job.');
  await usableJob(ctx, item); return item;
}
async function failJobResource(ctx: any, item: any) {
  if (!['source', 'artifact'].includes(item.resourceKind) || !item.resourceId || item.expectedRevision === undefined) return;
  const record = await resource(ctx, item.ownerId, item.resourceKind, item.resourceId);
  if (record.revision !== item.expectedRevision || !['queued', 'processing', 'running'].includes(record.data.status)) return;
  const updatedAt = stamp(), nextRevision = record.revision + 1;
  const error = item.code === 'DAILY_USAGE_LIMIT' ? 'The daily generation allowance has been reached. Retry after midnight UTC; saved work remains available.' : item.code === 'WORK_CAPACITY' ? 'Generation capacity remained busy after bounded retries. Retry this item after the current work finishes.' : 'Background processing could not finish after bounded retries. Retry this item.';
  await ctx.db.patch(record._id, { revision: nextRevision, updatedAt, data: { ...record.data, status: 'failed', revision: nextRevision, updatedAt, error } });
  const owner = await activeOwner(ctx, item.ownerId); await ctx.db.patch(owner._id, { revision: owner.revision + 1 });
}
async function acquireJob(ctx: any, args: { jobId: string; workerId: string; leaseMs: number }) {
  const item = await byId(ctx, 'jobs', args.jobId); if (!item || !['pending', 'running'].includes(item.state) || item.availableAt > Date.now()) return null;
  if (item.state === 'running' && item.lockedUntil > Date.now()) { await ctx.scheduler.runAt(item.lockedUntil + 1, jobRun, { jobId: item.id }); return null; }
  try { await usableJob(ctx, item); } catch { await ctx.db.patch(item._id, { state: 'cancelled', updatedAt: stamp() }); return null; }
  if (item.attempts >= 3) { await ctx.db.patch(item._id, { state: 'failed', code: 'RETRY_LIMIT', lockedUntil: undefined, workerId: undefined, updatedAt: stamp() }); await failJobResource(ctx, item); return null; }
  const update = { state: 'running', attempts: item.attempts + 1, fence: item.fence + 1, workerId: args.workerId, lockedUntil: Date.now() + Math.min(180000, Math.max(1000, args.leaseMs)), updatedAt: stamp() };
  await ctx.db.patch(item._id, update);
  // A recovery check remains durable if the worker/action dies before reporting a result.
  await ctx.scheduler.runAt(update.lockedUntil + 1, jobRun, { jobId: item.id });
  return jobView({ ...item, ...update });
}
async function completeJob(ctx: any, args: any) { const item = await jobOwned(ctx, args.jobId, args.workerId, args.fence); await ctx.db.patch(item._id, { state: 'completed', lockedUntil: undefined, updatedAt: stamp() }); return null; }
async function failJob(ctx: any, args: any) {
  const item = await jobOwned(ctx, args.jobId, args.workerId, args.fence), retry = args.retryAt && item.attempts < 3 ? Date.parse(args.retryAt) : undefined;
  if (retry !== undefined && !Number.isFinite(retry)) fail('INVALID_JOB', 400, 'Invalid retry schedule.');
  const update = { state: retry === undefined ? 'failed' : 'pending', lockedUntil: undefined, workerId: undefined, availableAt: retry ?? item.availableAt, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(args.code) ? args.code : 'JOB_FAILED', updatedAt: stamp() };
  await ctx.db.patch(item._id, update); if (retry !== undefined) await schedule(ctx, { ...item, ...update }); else await failJobResource(ctx, { ...item, ...update }); return null;
}
async function renewJob(ctx: any, args: any) {
  let item; try { item = await jobOwned(ctx, args.jobId, args.workerId, args.fence); } catch { return false; }
  await ctx.db.patch(item._id, { lockedUntil: Date.now() + Math.min(180000, Math.max(1000, args.leaseMs ?? 30000)), updatedAt: stamp() }); return true;
}
export const jobLookup = internalQuery({ args: { jobId: v.string() }, handler: async (ctx, args) => { const item = await byId(ctx, 'jobs', args.jobId); return item ? jobView(item) : null; } });
export const jobAcquire = internalMutation({ args: { jobId: v.string(), workerId: v.string(), leaseMs: v.number() }, handler: acquireJob });
export const jobRenew = internalMutation({ args: { jobId: v.string(), workerId: v.string(), fence: v.number(), leaseMs: v.optional(v.number()) }, handler: renewJob });
export const jobComplete = internalMutation({ args: { jobId: v.string(), workerId: v.string(), fence: v.number() }, handler: completeJob });
export const jobFail = internalMutation({ args: { jobId: v.string(), workerId: v.string(), fence: v.number(), retryAt: v.optional(v.string()), code: v.string() }, handler: failJob });

export const read = query({ args: { operation: v.string(), principal: v.optional(v.any()), input: v.any() }, handler: async (ctx, args) => {
  await service(ctx); const input = args.input;
  if (args.operation === 'authenticate') {
    const auth = await ctx.db.query('authSessions').withIndex('by_token', q => q.eq('tokenHash', input.tokenHash)).unique();
    if (!auth || auth.revokedAt !== undefined || auth.expiresAt <= Date.now()) fail('UNAUTHORIZED', 401, 'A valid session is required.');
    let owner; try { owner = await activeOwner(ctx, auth.ownerId); } catch { fail('UNAUTHORIZED', 401, 'A valid session is required.'); } return { value: principalOf(owner, auth) };
  }
  if (args.operation === 'principalForOwner') return { value: principalOf(await activeOwner(ctx, input.ownerId)) };
  if (args.operation === 'resolveShare') {
    if (!/^[a-f0-9]{64}$/.test(input.hash)) return { value: null };
    const rows = await ctx.db.query('resources').withIndex('by_shared_id', q => q.eq('kind', 'share').eq('id', input.hash)).take(2), row = rows[0];
    if (rows.length !== 1 || !row || row.deletedAt !== undefined || row.data.revoked !== false || !Number.isFinite(Date.parse(row.data.expiresAt)) || Date.parse(row.data.expiresAt) <= Date.now()) return { value: null };
    try { const owner = await activeOwner(ctx, row.ownerId); return { value: { principal: principalOf(owner), record: publicResource(await resource(ctx, owner.id, 'share', input.hash)) } }; } catch { return { value: null }; }
  }
  if (args.operation === 'job') { const item = await byId(ctx, 'jobs', input.id); return { value: item ? jobView(item) : null }; }
  if (args.operation === 'health') return { value: true };
  if (args.operation === 'fenceActive') { const item = await ctx.db.query('fences').withIndex('by_key', q => q.eq('key', input.key)).unique(); return { value: Boolean(item && item.expiresAt > Date.now()) }; }
  const owner = await authorize(ctx, args.principal), ownerId = owner.id;
  let value: any;
  switch (args.operation) {
    case 'version': value = null; break;
    case 'session': value = (await session(ctx, ownerId, input.id)).snapshot; break;
    case 'sessions': value = (await ctx.db.query('sessions').withIndex('by_owner', q => q.eq('ownerId', ownerId)).order('desc').take(500)).filter(item => item.deletedAt === undefined).map(item => item.snapshot); break;
    case 'resource': value = publicResource(await resource(ctx, ownerId, input.kind, input.id)); break;
    case 'resources': {
      if (input.sessionId) await session(ctx, ownerId, input.sessionId);
      const rows = await ctx.db.query('resources').withIndex('by_kind', q => q.eq('ownerId', ownerId).eq('kind', input.kind)).take(2000); value = [];
      for (const row of rows) { if (row.deletedAt !== undefined || input.sessionId && row.sessionId !== input.sessionId) continue; try { value.push(publicResource(await resource(ctx, ownerId, row.kind, row.id))); } catch { /* Parent tombstones suppress child rows. */ } }
      value = value.sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(1000, input.limit ?? 100)); break;
    }
    case 'receipt': value = await ctx.db.query('receipts').withIndex('by_key', q => q.eq('ownerId', ownerId).eq('sessionId', input.id).eq('key', input.key)).unique(); break;
    case 'events': await session(ctx, ownerId, input.id); value = (await ctx.db.query('events').withIndex('by_sequence', q => q.eq('ownerId', ownerId).eq('sessionId', input.id).gt('sequence', input.after ?? 0)).take(Math.min(500, input.limit ?? 100))).map(publicResource); break;
    case 'chunks': {
      if (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 20) fail('INVALID_SOURCE_FILTER', 400, 'Choose one to twenty sources.');
      value = []; for (const sourceId of input.sourceIds) { await resource(ctx, ownerId, 'source', sourceId); const rows = await ctx.db.query('chunks').withSearchIndex('by_text', q => q.search('text', input.text).eq('ownerId', ownerId).eq('sourceId', sourceId)).take(Math.min(20, input.limit ?? 8)); value.push(...rows.map((row, index) => { const { embedding, ownerId: _, scope, ...data } = publicResource(row); return { ...data, score: 1 / (index + 1) }; })); }
      value = value.sort((a: any, b: any) => b.score - a.score).slice(0, Math.min(20, input.limit ?? 8)); break;
    }
    case 'vectorResults': {
      value = []; for (const hit of input.hits) { const row: any = await ctx.db.get(hit.id); if (!row || row.ownerId !== ownerId || !input.sourceIds.includes(row.sourceId)) continue; await resource(ctx, ownerId, 'source', row.sourceId); const { embedding, ownerId: _, scope, ...data } = publicResource(row); value.push({ ...data, score: hit.score }); } break;
    }
    default: fail('INVALID_OPERATION', 400, 'Unknown storage operation.');
  }
  return { value, ownerRevision: owner.revision };
} });

export const identity = mutation({ args: { operation: v.string(), input: v.any() }, handler: async (ctx, args) => {
  await service(ctx); const input = args.input;
  if (args.operation === 'guest') {
    await ctx.db.insert('owners', { id: input.ownerId, kind: 'guest', revision: 0, eventSequence: 0, expiresAt: input.expiresAt });
    await ctx.db.insert('authSessions', { id: input.authId, ownerId: input.ownerId, tokenHash: input.tokenHash, expiresAt: input.expiresAt }); return null;
  }
  if (args.operation === 'user') {
    let owner = await ctx.db.query('owners').withIndex('by_identity', q => q.eq('issuer', input.issuer).eq('subject', input.subject)).unique();
    if (owner?.deletedAt !== undefined) fail('ACCOUNT_DELETED', 410, 'This account has been deleted.');
    if (!owner) { const id = await ctx.db.insert('owners', { id: input.ownerId, kind: 'user', revision: 0, eventSequence: 0, issuer: input.issuer, subject: input.subject, ...(input.displayName ? { displayName: input.displayName } : {}) }); owner = await ctx.db.get(id); }
    const auth = { id: input.authId, ownerId: owner!.id, tokenHash: input.tokenHash, expiresAt: input.expiresAt }; await ctx.db.insert('authSessions', auth); return principalOf(owner, auth);
  }
  const owner = await authorize(ctx, input.principal);
  if (args.operation === 'revoke') { const auth = await byId(ctx, 'authSessions', input.principal.authSessionId); await ctx.db.patch(auth._id, { revokedAt: Date.now() }); return null; }
  if (args.operation === 'delete') {
    await ctx.db.patch(owner._id, { deletedAt: Date.now(), revision: owner.revision + 1 });
    if (owner.issuer === 'urn:tokai:native-auth' && owner.subject) await ctx.scheduler.runAfter(0, internal.nativeAuth.cleanup, { subject: owner.subject });
    return null;
  }
  if (args.operation === 'claim') {
    const user = await authorize(ctx, input.user); if (owner.kind !== 'guest' || user.kind !== 'user') fail('INVALID_CLAIM', 400, 'A guest can only be claimed by an account.');
    await claimUsage(ctx, owner.id, user.id);
    // The owner revision guards make concurrent API writes conflict after transfer.
    for (const table of ['sessions', 'resources', 'events', 'receipts', 'jobs', 'chunks']) {
      const rows = await ctx.db.query(table as any).filter(q => q.eq(q.field('ownerId'), owner.id)).take(5000);
      if (rows.length >= 5000) fail('CLAIM_TOO_LARGE', 409, 'This guest needs a background transfer before it can be claimed.');
      for (const row of rows) {
        if (table === 'resources') { const old: any = row, targetId = old.kind === 'preferences' && old.id === owner.id ? user.id : old.id; const duplicate = await ctx.db.query('resources').withIndex('by_key', q => q.eq('ownerId', user.id).eq('kind', old.kind).eq('id', targetId)).unique(); if (duplicate) { if (old.kind === 'preferences') { await ctx.db.delete(row._id); continue; } fail('CLAIM_CONFLICT', 409, 'A saved item conflicts with this account.'); } if (targetId !== old.id) await ctx.db.patch(row._id, { id: targetId }); }
        if (table === 'chunks') await ctx.db.patch(row._id, { scope: `${user.id}:${(row as any).sourceId}` });
        await ctx.db.patch(row._id, { ownerId: user.id });
      }
    }
    await ctx.db.patch(owner._id, { deletedAt: Date.now(), revision: owner.revision + 1 }); await ctx.db.patch(user._id, { revision: user.revision + 1, eventSequence: Math.max(user.eventSequence, owner.eventSequence) }); return null;
  }
  fail('INVALID_OPERATION', 400, 'Unknown identity operation.');
} });

export const commit = mutation({ args: { principal: v.any(), ownerRevision: v.number(), operations: v.array(v.any()) }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal); assertRevision(owner.revision, args.ownerRevision);
  if (args.operations.length > 300) fail('TRANSACTION_LIMIT', 413, 'Too many changes in one operation.');
  let eventSequence = owner.eventSequence;
  for (const op of args.operations) {
    bounded(op); const ownerId = owner.id;
    if (op.type === 'session.create') { if (await byId(ctx, 'sessions', op.session.id)) fail('REVISION_CONFLICT', 409, 'That lesson already exists.'); await ctx.db.insert('sessions', { id: op.session.id, ownerId, revision: op.session.revision, snapshot: op.session, updatedAt: op.session.updatedAt }); }
    else if (op.type === 'session.save') {
      const item = await session(ctx, ownerId, op.session.id); assertRevision(item.revision, op.expectedRevision); assertRevision(op.session.revision, item.revision + 1);
      if (op.lease) { const lease = await ctx.db.query('fences').withIndex('by_key', q => q.eq('key', op.lease.key)).unique(); if (!lease || lease.fence !== op.lease.fence || lease.expiresAt <= Date.now()) fail('LEASE_LOST', 409, 'This connection no longer owns the lesson.'); }
      await ctx.db.patch(item._id, { revision: op.session.revision, snapshot: op.session, updatedAt: op.session.updatedAt });
    } else if (op.type === 'session.delete') { const item = await session(ctx, ownerId, op.id); await ctx.db.patch(item._id, { deletedAt: Date.now() }); }
    else if (op.type === 'resource.put') {
      const old = await ctx.db.query('resources').withIndex('by_key', q => q.eq('ownerId', ownerId).eq('kind', op.kind).eq('id', op.id)).unique();
      if (op.sessionId) await session(ctx, ownerId, op.sessionId);
      if (old) { if (old.deletedAt !== undefined) fail('NOT_FOUND', 404, 'This item has been deleted.'); if (old.sessionId) await session(ctx, ownerId, old.sessionId); if (op.sessionId !== undefined && op.sessionId !== old.sessionId) fail('INVALID_PARENT', 400, 'An item cannot change lessons.'); assertRevision(old.revision, op.expectedRevision); await ctx.db.patch(old._id, { data: op.data, revision: old.revision + 1, updatedAt: stamp() }); }
      else { assertRevision(-1, op.expectedRevision); await ctx.db.insert('resources', { ownerId, kind: op.kind, id: op.id, ...(op.sessionId ? { sessionId: op.sessionId } : {}), data: op.data, revision: 0, createdAt: stamp(), updatedAt: stamp() }); }
    } else if (op.type === 'resource.delete') { const old = await resource(ctx, ownerId, op.kind, op.id); await ctx.db.patch(old._id, { deletedAt: Date.now() }); }
    else if (op.type === 'event') {
      await session(ctx, ownerId, op.id); const old = await ctx.db.query('events').withIndex('by_event', q => q.eq('ownerId', ownerId).eq('sessionId', op.id).eq('id', op.event.id)).unique();
      if (!old) { eventSequence++; await ctx.db.insert('events', { ownerId, sessionId: op.id, ...op.event, data: op.event.data ?? null, sequence: eventSequence, createdAt: stamp() }); }
    } else if (op.type === 'receipt') { await ctx.db.insert('receipts', { ownerId, sessionId: op.id, key: op.key, hash: op.hash, result: op.result ?? null }); }
    else if (op.type === 'job.guard') {
      const job = await jobOwned(ctx, op.job.id, op.job.workerId, op.job.fence); if (job.ownerId !== ownerId) fail('JOB_LEASE_LOST', 409, 'This job belongs to another owner.');
    } else if (op.type === 'job') {
      const intent = op.intent; if (intent.sessionId) await session(ctx, ownerId, intent.sessionId); if (intent.resourceId) { const r = await resource(ctx, ownerId, intent.resourceKind, intent.resourceId); if (intent.expectedRevision !== undefined) assertRevision(r.revision, intent.expectedRevision); }
      const old = await byId(ctx, 'jobs', intent.id);
      if (old) { for (const key of ['ownerId', 'kind', 'sessionId', 'resourceKind', 'resourceId', 'expectedRevision']) if (old[key] !== (key === 'ownerId' ? ownerId : intent[key])) fail('IDEMPOTENCY_CONFLICT', 409, 'That job identifier was already used.'); }
      else { const value = { ...intent, ownerId, state: 'pending', attempts: 0, fence: 0, availableAt: intent.availableAt ? Date.parse(intent.availableAt) : Date.now(), createdAt: stamp(), updatedAt: stamp() }; const id = await ctx.db.insert('jobs', value); await schedule(ctx, { ...value, _id: id }); }
    } else if (op.type === 'chunks.replace' || op.type === 'chunks.append' || op.type === 'chunks.delete') {
      const source = await resource(ctx, ownerId, 'source', op.sourceId); if (op.type !== 'chunks.delete') assertRevision(source.revision, op.sourceRevision);
      if (op.type !== 'chunks.append') { const old = await ctx.db.query('chunks').withIndex('by_source', q => q.eq('ownerId', ownerId).eq('sourceId', op.sourceId)).take(2001); for (const row of old) await ctx.db.delete(row._id); }
      for (const chunk of op.chunks ?? []) await ctx.db.insert('chunks', { ...chunk, ownerId, scope: `${ownerId}:${op.sourceId}` });
    } else fail('INVALID_OPERATION', 400, 'Unknown transaction operation.');
  }
  if (args.operations.length) await ctx.db.patch(owner._id, { revision: owner.revision + 1, eventSequence }); return null;
} });

export const jobControl = mutation({ args: { operation: v.string(), input: v.any() }, handler: async (ctx, args) => {
  await service(ctx); const input = args.input;
  if (args.operation === 'complete') return completeJob(ctx, input);
  if (args.operation === 'renew') return renewJob(ctx, input);
  if (args.operation === 'fail') return failJob(ctx, input);
  if (args.operation === 'claim') {
    const pending = await ctx.db.query('jobs').withIndex('by_state_time', q => q.eq('state', 'pending').lte('availableAt', Date.now())).take(Math.min(100, input.limit ?? 10));
    const expired = await ctx.db.query('jobs').withIndex('by_state_time', q => q.eq('state', 'running')).filter(q => q.lte(q.field('lockedUntil'), Date.now())).take(Math.min(100, input.limit ?? 10)); const result = [];
    for (const item of [...pending, ...expired].slice(0, Math.min(100, input.limit ?? 10))) { const acquired = await acquireJob(ctx, { jobId: item.id, workerId: input.workerId, leaseMs: input.leaseMs ?? 30000 }); if (acquired) result.push(acquired); } return result;
  }
  fail('INVALID_OPERATION', 400, 'Unknown job operation.');
} });
export const fence = mutation({ args: { operation: v.string(), key: v.string(), fence: v.optional(v.number()), token: v.optional(v.string()), ttlMs: v.optional(v.number()) }, handler: async (ctx, args) => {
  await service(ctx); const old = await ctx.db.query('fences').withIndex('by_key', q => q.eq('key', args.key)).unique(), expiry = Date.now() + Math.min(120000, Math.max(1000, args.ttlMs ?? 15000));
  if (args.operation === 'next' || args.operation === 'acquire') {
    if (args.operation === 'acquire' && old && old.expiresAt > Date.now()) return null;
    const update = { key: args.key, fence: (old?.fence ?? 0) + 1, expiresAt: expiry, ...(args.token ? { token: args.token } : {}) }; if (old) await ctx.db.replace(old._id, update); else await ctx.db.insert('fences', update); return update.fence;
  }
  if (!old || old.fence !== args.fence || args.token && old.token !== args.token) return false;
  if (args.operation === 'renew') { if (old.expiresAt <= Date.now()) return false; await ctx.db.patch(old._id, { expiresAt: expiry }); return true; }
  if (args.operation === 'release') { await ctx.db.patch(old._id, { expiresAt: Date.now() }); return true; }
  fail('INVALID_OPERATION', 400, 'Unknown lease operation.');
} });
export const vectorSearch = action({ args: { principal: v.any(), sourceIds: v.array(v.string()), embedding: v.array(v.number()), limit: v.optional(v.number()) }, handler: async (ctx, args) => {
  await service(ctx); if (args.embedding.length !== 384 || args.embedding.some(value => !Number.isFinite(value)) || args.sourceIds.length < 1 || args.sourceIds.length > 20) fail('INVALID_EMBEDDING', 400, 'Invalid source vector search.');
  const hits = [];
  for (const sourceId of args.sourceIds) {
    await ctx.runQuery(readRef, { operation: 'resource', principal: args.principal, input: { kind: 'source', id: sourceId } });
    const rows = await ctx.vectorSearch('chunks', 'by_embedding', { vector: args.embedding, limit: Math.min(20, args.limit ?? 8), filter: q => q.eq('scope', `${args.principal.ownerId}:${sourceId}`) }); hits.push(...rows.map(row => ({ id: row._id, score: row._score })));
  }
  hits.sort((a, b) => b.score - a.score);
  return ctx.runQuery(readRef, { operation: 'vectorResults', principal: args.principal, input: { sourceIds: args.sourceIds, hits: hits.slice(0, Math.min(20, args.limit ?? 8)) } });
} });

/** One-time, service-only migration of a validated legacy owner batch; never overwrites live data. */
export const importLegacy = mutation({ args: { digest: v.string(), batch: v.any() }, handler: async (ctx, args) => {
  await service(ctx); if (!/^[a-f0-9]{64}$/.test(args.digest)) fail('INVALID_IMPORT', 400, 'Invalid migration digest.');
  const prior = await ctx.db.query('imports').withIndex('by_digest', q => q.eq('digest', args.digest)).unique(); if (prior) return { imported: 0, skipped: prior.sessions, alreadyImported: true };
  const batch = args.batch; if (batch.sessions.length > 500 || batch.auth.length > 500 || batch.resources.length > 2000) fail('IMPORT_TOO_LARGE', 413, 'This owner needs a smaller migration batch.');
  let owner = await byId(ctx, 'owners', batch.owner.id);
  if (owner?.deletedAt !== undefined) fail('OWNER_DELETED', 409, 'A deleted owner cannot be restored by migration.');
  if (!owner) { const id = await ctx.db.insert('owners', { ...batch.owner, revision: 0, eventSequence: 0 }); owner = await ctx.db.get(id); }
  for (const auth of batch.auth) {
    const old = await ctx.db.query('authSessions').withIndex('by_token', q => q.eq('tokenHash', auth.tokenHash)).unique();
    if (old && old.ownerId !== owner!.id) fail('IMPORT_OWNERSHIP_CONFLICT', 409, 'A migrated credential belongs to another owner.');
    if (!old) { if (await byId(ctx, 'authSessions', auth.id)) fail('IMPORT_ID_CONFLICT', 409, 'A migrated authentication ID conflicts.'); await ctx.db.insert('authSessions', auth); }
  }
  let imported = 0, skipped = 0;
  for (const record of batch.sessions) {
    bounded(record.snapshot); const old = await byId(ctx, 'sessions', record.id);
    if (old) { if (old.ownerId !== owner!.id) fail('IMPORT_OWNERSHIP_CONFLICT', 409, 'A migrated lesson belongs to another owner.'); skipped++; }
    else { await ctx.db.insert('sessions', record); imported++; }
  }
  for (const item of batch.resources) {
    bounded(item.data); const old = await ctx.db.query('resources').withIndex('by_key', q => q.eq('ownerId', owner!.id).eq('kind', item.kind).eq('id', item.id)).unique();
    if (!old) await ctx.db.insert('resources', item);
  }
  await ctx.db.patch(owner!._id, { revision: owner!.revision + 1 });
  await ctx.db.insert('imports', { digest: args.digest, ownerId: owner!.id, importedAt: Date.now(), sessions: batch.sessions.length }); return { imported, skipped, alreadyImported: false };
} });
