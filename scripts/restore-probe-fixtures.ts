/** Deployed only into verify-restore's isolated3212 instance, never the application backend. */
export const restoreProbeFunctions = String.raw`
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { updateStorageInventory } from './usage';
export const addFile = internalAction({ args: {}, handler: async ctx => {
  const text = 'milli isolated restore verification.\n'.repeat(1024);
  const storageId = await ctx.storage.store(new Blob([text], { type: 'text/plain' }));
  await ctx.runMutation(makeFunctionReference('restoreProbe:saveFile'), { storageId, size: new TextEncoder().encode(text).length });
  return { added: true };
} });
export const saveFile = internalMutation({ args: { storageId: v.id('_storage'), size: v.number() }, handler: async (ctx, args) => {
  await ctx.db.insert('files', { key: 'restore-verification-private-file', storageId: args.storageId, size: args.size, contentType: 'text/plain' });
} });
export const removeFile = internalMutation({ args: {}, handler: async ctx => {
  const item = await ctx.db.query('files').withIndex('by_key', q => q.eq('key', 'restore-verification-private-file')).unique();
  if (!item) throw new Error('PROBE_FILE_MISSING');
  await ctx.storage.delete(item.storageId); await ctx.db.delete(item._id); return { removed: true };
} });
export const seedJobs = internalMutation({ args: {}, handler: async ctx => {
  const now = Date.now(), ownerId = 'restore-probe-owner', deletedOwnerId = 'restore-probe-deleted-owner', at = new Date(now).toISOString();
  await ctx.db.insert('owners', { id: ownerId, kind: 'user', revision: 0, eventSequence: 0 });
  await ctx.db.insert('owners', { id: deletedOwnerId, kind: 'user', revision: 0, eventSequence: 0, deletedAt: now });
  const resourceId = 'restore-probe-exhausted-artifact';
  await ctx.db.insert('resources', { id: resourceId, ownerId, kind: 'artifact', revision: 0, data: { status: 'queued' }, createdAt: at, updatedAt: at });
  for (const [id, extra] of Object.entries({ orphan: {}, scheduled: {}, expired: { state: 'running', attempts: 1, fence: 8, workerId: 'expired-worker', lockedUntil: now - 1 }, live: { state: 'running', attempts: 1, fence: 4, workerId: 'live-worker', lockedUntil: now + 60000 }, done: { state: 'completed' }, exhausted: { state: 'running', attempts: 3, fence: 6, workerId: 'exhausted-worker', lockedUntil: now - 1, resourceKind: 'artifact', resourceId, expectedRevision: 0 }, deleted: { ownerId: deletedOwnerId } })) {
    const jobId = 'restore-probe-' + id;
    const scheduledId = id === 'scheduled' ? await ctx.scheduler.runAt(now + 3600000, makeFunctionReference('jobs:run'), { jobId }) : undefined;
    await ctx.db.insert('jobs', { id: jobId, ownerId, kind: 'restore.no-provider', state: 'pending', attempts: 0, fence: 0, availableAt: now + 3600000, createdAt: at, updatedAt: at, ...extra, ...(scheduledId ? { scheduledId } : {}) });
  }
  return null;
} });
export const jobState = internalQuery({ args: {}, handler: async ctx => {
  const rows = await ctx.db.query('jobs').withIndex('by_owner', q => q.eq('ownerId', 'restore-probe-owner')).collect();
  const cancelled = await ctx.db.query('jobs').withIndex('by_external_id', q => q.eq('id', 'restore-probe-deleted')).unique();
  const failedResource = await ctx.db.query('resources').withIndex('by_key', q => q.eq('ownerId', 'restore-probe-owner').eq('kind', 'artifact').eq('id', 'restore-probe-exhausted-artifact')).unique();
  return { rows, cancelled, failedResource };
} });
export const verifyRecovery = internalAction({ args: {}, handler: async ctx => {
  await ctx.runMutation(makeFunctionReference('restoreProbe:seedJobs'), {});
  const before: any = await ctx.runQuery(makeFunctionReference('restoreProbe:jobState'), {});
  await ctx.runMutation(makeFunctionReference('recovery:sweep'), {});
  let after: any;
  for (let i = 0; i < 100; i++) {
    after = await ctx.runQuery(makeFunctionReference('restoreProbe:jobState'), {});
    if (after.rows.find((row: any) => row.id === 'restore-probe-orphan')?.scheduledId) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const row = (key: string) => after.rows.find((item: any) => item.id === 'restore-probe-' + key);
  const checks = {
    pendingRecovered: Boolean(row('orphan')?.scheduledId),
    existingScheduleRetained: row('scheduled')?.scheduledId === before.rows.find((item: any) => item.id === 'restore-probe-scheduled')?.scheduledId,
    expiredFenceRevoked: row('expired')?.fence === 9 && row('expired')?.state === 'pending' && !row('expired')?.workerId,
    activeLeasePreserved: row('live')?.fence === 4 && row('live')?.workerId === 'live-worker' && row('live')?.state === 'running',
    completedNotReplayed: row('done')?.state === 'completed' && !row('done')?.scheduledId,
    retriesBounded: row('exhausted')?.state === 'failed' && after.failedResource?.data.status === 'failed',
    deletedOwnerCancelled: after.cancelled?.state === 'cancelled',
  };
  if (Object.values(checks).some(value => !value)) throw new Error('RECOVERY_ASSERTION_FAILED');
  let staleRejected = false;
  try { await ctx.runMutation(makeFunctionReference('store:jobComplete'), { jobId: 'restore-probe-expired', workerId: 'expired-worker', fence: 8 }); } catch { staleRejected = true; }
  if (!staleRejected) throw new Error('STALE_WORKER_PUBLISHED');
  await ctx.runMutation(makeFunctionReference('recovery:sweep'), {});
  const repeated: any = await ctx.runQuery(makeFunctionReference('restoreProbe:jobState'), {});
  if (repeated.rows.find((item: any) => item.id === 'restore-probe-orphan')?.scheduledId !== row('orphan').scheduledId) throw new Error('RECOVERY_DUPLICATED_TIMER');
  return { ...checks, staleWorkerRejected: true, repeatedSweepIdempotent: true };
} });
export const seedRetention = internalMutation({ args: {}, handler: async ctx => {
  const now = Date.now(), ownerId = 'restore-retention-owner', sessionId = 'restore-retention-session', at = new Date(now - 3 * 86400000).toISOString();
  await ctx.db.insert('owners', { id: ownerId, kind: 'user', revision: 0, eventSequence: 0 });
  await ctx.db.insert('owners', { id: 'restore-expired-guest', kind: 'guest', revision: 0, eventSequence: 0, expiresAt: now - 1 });
  await ctx.db.insert('usageStorage', { ownerId: 'restore-expired-guest', bytes: 0, objects: 0, updatedAt: now });
  if (!await ctx.db.query('usageStorage').withIndex('by_owner', q => q.eq('ownerId', 'global')).unique()) await ctx.db.insert('usageStorage', { ownerId: 'global', bytes: 0, objects: 0, updatedAt: now });
  await ctx.db.insert('sessions', { id: sessionId, ownerId, revision: 0, updatedAt: at, snapshot: { messages: [{ text: 'Private isolated retention fixture' }], settings: { preferences: { retentionDays: 1 } } } });
  await ctx.db.insert('resources', { id: 'restore-retention-note', ownerId, sessionId, kind: 'note', revision: 0, createdAt: at, updatedAt: at, data: { text: 'Private isolated fixture note' } });
  await ctx.db.insert('authSessions', { id: 'restore-expired-auth', ownerId, tokenHash: 'isolated-fixture-hash', expiresAt: now - 1 });
  await ctx.db.insert('events', { id: 'restore-retention-event', ownerId, sessionId, sequence: 1, type: 'fixture', data: { text: 'Private isolated fixture event' }, createdAt: at });
  const day = new Date(now).toISOString().slice(0, 10), totals = { units: 1, requests: 1, succeeded: 1, failed: 0 };
  await ctx.db.insert('usageDays', { scope: 'session:' + ownerId + '/' + sessionId, day, kind: 'model', totals });
  await ctx.db.insert('usageDays', { scope: 'owner:' + ownerId, day, kind: 'model', totals });
  return null;
} });
export const seedRetentionFiles = internalAction({ args: {}, handler: async ctx => {
  const bytes = new TextEncoder().encode('retention fixture');
  const expired = await ctx.storage.store(new Blob([bytes], { type: 'text/plain' }));
  const active = await ctx.storage.store(new Blob([bytes], { type: 'text/plain' }));
  await ctx.runMutation(makeFunctionReference('restoreProbe:saveRetentionFiles'), { expired, active, size: bytes.length });
} });
export const saveRetentionFiles = internalMutation({ args: { expired: v.id('_storage'), active: v.id('_storage'), size: v.number() }, handler: async (ctx, args) => {
  const ownerId = 'restore-retention-owner', now = Date.now(), at = new Date(now).toISOString();
  for (const label of ['expired', 'active'] as const) {
    const id = 'restore-' + label + '-file', expiresAt = label === 'expired' ? now - 1 : now + 86400000;
    await ctx.db.insert('resources', { id, ownerId, kind: 'source', revision: 0, createdAt: at, updatedAt: at, data: { status: 'ready', fileExpiresAt: new Date(expiresAt).toISOString() } });
    await ctx.db.insert('files', { key: 'source/' + id, storageId: args[label], size: args.size, contentType: 'text/plain', ownerId, expiresAt });
  }
  await ctx.db.insert('chunks', { id: 'restore-expired-file-chunk', ownerId, sourceId: 'restore-expired-file', scope: ownerId + ':restore-expired-file', revision: 0, ordinal: 0, text: 'Still consented indexed text' });
  await updateStorageInventory(ctx, ownerId, args.size * 2, 2);
} });
export const retentionState = internalQuery({ args: {}, handler: async ctx => {
  const guest = await ctx.db.query('owners').withIndex('by_external_id', q => q.eq('id', 'restore-expired-guest')).unique();
  const session = await ctx.db.query('sessions').withIndex('by_external_id', q => q.eq('id', 'restore-retention-session')).unique();
  const note = await ctx.db.query('resources').withIndex('by_key', q => q.eq('ownerId', 'restore-retention-owner').eq('kind', 'note').eq('id', 'restore-retention-note')).unique();
  const auth = await ctx.db.query('authSessions').withIndex('by_external_id', q => q.eq('id', 'restore-expired-auth')).unique();
  const events = await ctx.db.query('events').withIndex('by_event', q => q.eq('ownerId', 'restore-retention-owner').eq('sessionId', 'restore-retention-session')).collect();
  const sessionUsage = await ctx.db.query('usageDays').withIndex('by_scope_day_kind', q => q.eq('scope', 'session:restore-retention-owner/restore-retention-session')).first();
  const ownerUsage = await ctx.db.query('usageDays').withIndex('by_scope_day_kind', q => q.eq('scope', 'owner:restore-retention-owner')).first();
  const expiredInventory = await ctx.db.query('usageStorage').withIndex('by_owner', q => q.eq('ownerId', 'restore-expired-guest')).unique();
  const globalInventory = await ctx.db.query('usageStorage').withIndex('by_owner', q => q.eq('ownerId', 'global')).unique();
  const activeFile = await ctx.db.query('files').withIndex('by_key', q => q.eq('key', 'source/restore-active-file')).unique();
  const expiredFile = await ctx.db.query('files').withIndex('by_key', q => q.eq('key', 'source/restore-expired-file')).unique();
  const ownerInventory = await ctx.db.query('usageStorage').withIndex('by_owner', q => q.eq('ownerId', 'restore-retention-owner')).unique();
  const retainedChunk = await ctx.db.query('chunks').withIndex('by_source', q => q.eq('ownerId', 'restore-retention-owner').eq('sourceId', 'restore-expired-file')).first();
  return { expiredGuestRevoked: guest?.deletedAt !== undefined, retainedSessionCleared: session?.deletedAt !== undefined && Object.keys(session.snapshot).length === 0, childResourceCleared: note?.deletedAt !== undefined && Object.keys(note.data).length === 0, expiredCredentialRemoved: auth === null, childEventsRemoved: events.length === 0, privateSessionUsageRemoved: sessionUsage === null, aggregateOwnerUsagePreserved: ownerUsage?.totals.units === 1, deletedOwnerInventoryRemoved: expiredInventory === null, globalInventoryPreserved: globalInventory !== null, expiredRawFileRemoved: expiredFile === null, activeRawFilePreserved: activeFile !== null, inventoryTracksRemainingFile: ownerInventory?.objects === 1 && ownerInventory?.bytes === activeFile?.size, consentedIndexedTextPreserved: retainedChunk !== null };
} });
export const verifyRetention = internalAction({ args: {}, handler: async ctx => {
  await ctx.runMutation(makeFunctionReference('restoreProbe:seedRetention'), {});
  await ctx.runAction(makeFunctionReference('restoreProbe:seedRetentionFiles'), {});
  await ctx.runMutation(makeFunctionReference('maintenance:sweep'), {});
  for (let i = 0; i < 200; i++) {
    const state: any = await ctx.runQuery(makeFunctionReference('restoreProbe:retentionState'), {});
    if (Object.values(state).every(Boolean)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('RETENTION_ASSERTION_FAILED');
} });
`;
