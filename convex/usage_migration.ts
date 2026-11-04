import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { updateStorageInventory } from './usage';

/** Metadata-only bounded attribution for files created before usage metering. No file bytes change. */
export const backfill = internalMutation({ args: { cursor: v.optional(v.string()) }, handler: async (ctx, args) => {
  const page = await ctx.db.query('files').paginate({ cursor: args.cursor ?? null, numItems: 50 }); let attributed = 0;
  for (const file of page.page) {
    if (file.ownerId) continue;
    const [kind, id] = file.key.split('/'); if (!id || !['source', 'artifact'].includes(kind)) continue;
    const records = await ctx.db.query('resources').withIndex('by_shared_id', q => q.eq('kind', kind === 'source' ? 'source' : 'artifact-file').eq('id', id)).take(3);
    const matching = records.filter(record => record.deletedAt === undefined && (kind === 'source' ? file.key === `source/${id}` : record.data.storageKey === file.key));
    if (matching.length !== 1) continue;
    const record = matching[0]!, owner = await ctx.db.query('owners').withIndex('by_external_id', q => q.eq('id', record.ownerId)).unique();
    if (!owner || owner.deletedAt !== undefined) continue;
    await ctx.db.patch(file._id, { ownerId: record.ownerId, ...(record.sessionId ? { sessionId: record.sessionId } : {}) });
    await updateStorageInventory(ctx, record.ownerId, file.size, 1); attributed++;
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('usage_migration:backfill'), { cursor: page.continueCursor });
  return { scanned: page.page.length, attributed, done: page.isDone };
} });
