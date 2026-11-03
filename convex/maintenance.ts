import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

const tables = ['owners', 'sessions', 'resources', 'jobs', 'events', 'receipts', 'chunks', 'authSessions', 'files', '_storage'] as const;
const ownerFor = (ctx: any, id: string) => ctx.db.query('owners').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
const sessionFor = (ctx: any, id: string) => ctx.db.query('sessions').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
const resourceFor = (ctx: any, ownerId: string, kind: string, id: string) => ctx.db.query('resources').withIndex('by_key', (q: any) => q.eq('ownerId', ownerId).eq('kind', kind).eq('id', id)).unique();
const dead = (row: any, now: number) => !row || row.deletedAt !== undefined || row.kind === 'guest' && row.expiresAt <= now;
/** Each mutation processes at most 50 rows; pagination survives process restarts. */
export const sweep = internalMutation({ args: { table: v.optional(v.string()), cursor: v.optional(v.string()) }, handler: async (ctx, args) => {
  const table = args.table ?? 'owners'; if (!(tables as readonly string[]).includes(table)) throw new Error('Unknown cleanup table');
  const now = Date.now(), database: any = table === '_storage' ? ctx.db.system : ctx.db;
  const page = await database.query(table).paginate({ numItems: 50, cursor: args.cursor ?? null });
  for (const row of page.page) {
    if (table === '_storage') {
      if (row._creationTime < now - 3600000 && !await ctx.db.query('files').withIndex('by_storage', q => q.eq('storageId', row._id)).first()) await ctx.storage.delete(row._id);
      continue;
    }
    if (table === 'files') {
      // A grace period protects bytes uploaded immediately before their transactional pointer is published.
      if (row._creationTime >= now - 3600000) continue;
      const [kind, id] = row.key.split('/');
      if (!['artifact', 'source'].includes(kind) || !id) continue;
      const records = await ctx.db.query('resources').withIndex('by_shared_id', q => q.eq('kind', kind === 'artifact' ? 'artifact-file' : 'source').eq('id', id)).take(2);
      let referenced = false;
      for (const record of records) {
        const owner = await ownerFor(ctx, record.ownerId), session = record.sessionId ? await sessionFor(ctx, record.sessionId) : undefined;
        if (!dead(owner, now) && record.deletedAt === undefined && (!record.sessionId || !dead(session, now)) && (kind === 'source' || record.data.storageKey === row.key)) referenced = true;
      }
      if (!referenced) { await ctx.storage.delete(row.storageId); await ctx.db.delete(row._id); }
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
      const expired = row.kind === 'share' && (row.data.revoked || Date.parse(row.data.expiresAt) <= now)
        || row.kind === 'oidc-login' && row.data.expiresAt <= now
        || row.kind === 'source' && row.data.status === 'awaiting-upload' && Date.parse(row.createdAt) + 3600000 <= now;
      if (inaccessible || expired || row.deletedAt !== undefined) {
        if (Object.keys(row.data ?? {}).length || row.deletedAt === undefined) await ctx.db.patch(row._id, { deletedAt: row.deletedAt ?? now, data: {}, revision: row.revision + 1 });
        if (owner && owner.deletedAt === undefined && row.deletedAt === undefined) await ctx.db.patch(owner._id, { revision: owner.revision + 1 });
      }
    } else if (table === 'jobs') {
      const resource = row.resourceId ? await resourceFor(ctx, row.ownerId, row.resourceKind, row.resourceId) : undefined;
      if ((inaccessible || row.resourceId && dead(resource, now)) && ['pending', 'running'].includes(row.state)) {
        if (row.scheduledId) await ctx.scheduler.cancel(row.scheduledId);
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
