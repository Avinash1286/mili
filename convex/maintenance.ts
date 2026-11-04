import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { updateStorageInventory } from './usage';

const tables = ['owners', 'sessions', 'resources', 'jobs', 'events', 'receipts', 'chunks', 'authSessions', 'voiceTickets', 'transferTickets', 'usageDays', 'usageReservations', 'files', 'usageStorage', '_storage'] as const;
const ownerFor = (ctx: any, id: string) => ctx.db.query('owners').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
const sessionFor = (ctx: any, id: string) => ctx.db.query('sessions').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
const resourceFor = (ctx: any, ownerId: string, kind: string, id: string) => ctx.db.query('resources').withIndex('by_key', (q: any) => q.eq('ownerId', ownerId).eq('kind', kind).eq('id', id)).unique();
const dead = (row: any, now: number) => !row || row.deletedAt !== undefined || row.kind === 'guest' && row.expiresAt <= now;
/** Each mutation processes at most 50 rows; pagination survives process restarts. */
export const sweep = internalMutation({ args: { table: v.optional(v.string()), cursor: v.optional(v.string()) }, handler: async (ctx, args) => {
  const table = args.table ?? 'owners'; if (!(tables as readonly string[]).includes(table)) throw new Error('Unknown cleanup table');
  if (table === 'owners' && !args.cursor) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('usage_migration:backfill'), {});
  const now = Date.now(), database: any = table === '_storage' ? ctx.db.system : ctx.db;
  const page = await database.query(table).paginate({ numItems: 50, cursor: args.cursor ?? null });
  for (const row of page.page) {
    if (table === 'usageStorage') {
      // Files are swept first. Only their transactional removal changes the global
      // inventory; deleting an empty private counter must not subtract it twice.
      if (row.ownerId !== 'global' && dead(await ownerFor(ctx, row.ownerId), now)
        && !await ctx.db.query('files').withIndex('by_owner', q => q.eq('ownerId', row.ownerId)).first()) await ctx.db.delete(row._id);
      continue;
    }
    if (table === 'usageDays') {
      const ownerId = row.scope.startsWith('owner:') ? row.scope.slice(6) : row.scope.startsWith('session:') ? row.scope.slice(8).split('/')[0] : undefined;
      const owner = ownerId ? await ownerFor(ctx, ownerId) : undefined;
      const parentId = row.scope.startsWith('session:') ? row.scope.slice(8 + (ownerId?.length ?? 0) + 1) : undefined;
      const parent = parentId ? await sessionFor(ctx, parentId) : undefined;
      const expired = Date.parse(row.day) + (row.scope === 'global' ? 90 : 30) * 86400000 <= now;
      if (expired || row.scope !== 'global' && dead(owner, now) || parentId !== undefined && (dead(parent, now) || parent.ownerId !== ownerId)) await ctx.db.delete(row._id);
      continue;
    }
    if (['voiceTickets', 'transferTickets', 'usageReservations'].includes(table)) {
      const owner = await ownerFor(ctx, row.ownerId);
      if (dead(owner, now) || row.expiresAt + (table === 'usageReservations' ? 86400000 : 0) <= now) await ctx.db.delete(row._id);
      continue;
    }
    if (table === '_storage') {
      if (row._creationTime < now - 3600000 && !await ctx.db.query('files').withIndex('by_storage', q => q.eq('storageId', row._id)).first()) await ctx.storage.delete(row._id);
      continue;
    }
    if (table === 'files') {
      const [kind, id] = row.key.split('/');
      const owner = row.ownerId ? await ownerFor(ctx, row.ownerId) : undefined;
      const expired = row.expiresAt !== undefined && row.expiresAt <= now;
      const ownerDeleted = Boolean(row.ownerId && dead(owner, now));
      const records = ['artifact', 'source'].includes(kind) && id
        ? await ctx.db.query('resources').withIndex('by_shared_id', q => q.eq('kind', kind === 'artifact' ? 'artifact-file' : 'source').eq('id', id)).take(3) : [];
      let referenced = false, parentDeleted = false;
      for (const record of records) {
        const owner = await ownerFor(ctx, record.ownerId), session = record.sessionId ? await sessionFor(ctx, record.sessionId) : undefined;
        if ((!row.ownerId || row.ownerId === record.ownerId) && (record.deletedAt !== undefined || dead(owner, now) || record.sessionId && dead(session, now))) parentDeleted = true;
        if ((!row.ownerId || row.ownerId === record.ownerId) && !dead(owner, now) && record.deletedAt === undefined && (!record.sessionId || !dead(session, now) && session.ownerId === record.ownerId) && (kind === 'source' ? row.key === `source/${id}` : record.data.storageKey === row.key)) {
          referenced = true;
          if (expired && kind === 'artifact') {
            const artifact = await resourceFor(ctx, record.ownerId, 'artifact', id);
            // A running worker owns its revision fence; expire only published
            // artifacts. Sources retain parsed text until learner retention ends.
            if (artifact?.deletedAt === undefined && artifact?.data.status === 'ready') {
              const updatedAt = new Date(now).toISOString();
              await ctx.db.patch(artifact._id, { data: { ...artifact.data, status: 'failed', error: 'Saved file expired. Generate it again.', fileExpiresAt: new Date(row.expiresAt).toISOString(), revision: artifact.data.revision + 1, updatedAt }, revision: artifact.revision + 1, updatedAt });
              await ctx.db.patch(owner._id, { revision: owner.revision + 1 });
            }
          }
        }
      }
      // The grace period applies only to unfinished publication, never an
      // explicit expiry or deleted owner. Upload bytes without a pointer have a
      // separate _storage orphan sweep.
      if (expired || ownerDeleted || !referenced && (parentDeleted || row._creationTime < now - 3600000)) {
        if (row.ownerId) await updateStorageInventory(ctx, row.ownerId, -row.size, -1);
        await ctx.storage.delete(row.storageId); await ctx.db.delete(row._id);
      }
      continue;
    }
    if (table === 'owners') {
      if (row.deletedAt === undefined && row.kind === 'guest' && row.expiresAt <= now) await ctx.db.patch(row._id, { deletedAt: now, revision: row.revision + 1 });
      if (row.deletedAt !== undefined && (row.subject || row.issuer || row.displayName)) await ctx.db.patch(row._id, { subject: undefined, issuer: undefined, displayName: undefined });
      continue;
    }
    const owner = await ownerFor(ctx, row.ownerId), parent = row.sessionId ? await sessionFor(ctx, row.sessionId) : undefined;
    const inaccessible = dead(owner, now) || Boolean(row.sessionId && dead(parent, now));
    if (table === 'sessions') {
      const days = row.snapshot?.settings?.preferences?.retentionDays ?? 30;
      const expired = Date.parse(row.updatedAt) + Math.max(1, Math.min(365, days)) * 86400000 <= now;
      if (inaccessible || expired || row.deletedAt !== undefined) {
        if (row.snapshot?.messages || row.deletedAt === undefined) await ctx.db.patch(row._id, { deletedAt: row.deletedAt ?? now, snapshot: {}, revision: row.revision + 1 });
        if (owner && owner.deletedAt === undefined && row.deletedAt === undefined) await ctx.db.patch(owner._id, { revision: owner.revision + 1 });
      }
    } else if (table === 'resources') {
      const preferences = row.kind === 'source' && !row.sessionId ? await resourceFor(ctx, row.ownerId, 'preferences', row.ownerId) : undefined;
      const requestedDays = preferences?.data?.retentionDays;
      const retentionDays = Number.isSafeInteger(requestedDays) ? Math.max(1, Math.min(365, requestedDays)) : 30;
      const sourceRetentionExpired = row.kind === 'source' && !row.sessionId && Date.parse(row.createdAt) + retentionDays * 86400000 <= now;
      const expired = row.kind === 'share' && (row.data.revoked || Date.parse(row.data.expiresAt) <= now)
        || row.kind === 'oidc-login' && row.data.expiresAt <= now
        || row.kind === 'source' && row.data.status === 'awaiting-upload' && Date.parse(row.createdAt) + 3600000 <= now
        || sourceRetentionExpired;
      if (inaccessible || expired || row.deletedAt !== undefined) {
        if (Object.keys(row.data ?? {}).length || row.deletedAt === undefined) await ctx.db.patch(row._id, { deletedAt: row.deletedAt ?? now, data: {}, revision: row.revision + 1 });
        if (owner && owner.deletedAt === undefined && row.deletedAt === undefined) await ctx.db.patch(owner._id, { revision: owner.revision + 1 });
      }
    } else if (table === 'jobs') {
      const resource = row.resourceId ? await resourceFor(ctx, row.ownerId, row.resourceKind, row.resourceId) : undefined;
      if ((inaccessible || row.resourceId && dead(resource, now)) && ['pending', 'running'].includes(row.state)) {
        if (row.scheduledId) await ctx.scheduler.cancel(row.scheduledId).catch(() => undefined);
        await ctx.db.patch(row._id, { state: 'cancelled', code: 'RESOURCE_DELETED', fence: row.fence + 1, lockedUntil: undefined, workerId: undefined });
      }
    } else if (table === 'chunks') {
      const source = await resourceFor(ctx, row.ownerId, 'source', row.sourceId);
      if (inaccessible || dead(source, now)) await ctx.db.delete(row._id);
    } else if (table === 'authSessions') {
      if (inaccessible || row.expiresAt <= now || row.revokedAt !== undefined) await ctx.db.delete(row._id);
    } else if (inaccessible) await ctx.db.delete(row._id);
  }
  const next = page.isDone ? tables[tables.indexOf(table as typeof tables[number]) + 1] : table;
  if (next) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('maintenance:sweep'), { table: next, ...(page.isDone ? {} : { cursor: page.continueCursor }) });
  return { table, processed: page.page.length, done: !next };
} });
