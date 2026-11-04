import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

const run = makeFunctionReference<'action'>('jobs:run');
const own = (ctx: any, id: string) => ctx.db.query('owners').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
const parent = (ctx: any, id: string) => ctx.db.query('sessions').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
const target = (ctx: any, job: any) => ctx.db.query('resources').withIndex('by_key', (q: any) => q.eq('ownerId', job.ownerId).eq('kind', job.resourceKind).eq('id', job.resourceId)).unique();
const gone = (row: any, now: number) => !row || row.deletedAt !== undefined || row.kind === 'guest' && row.expiresAt <= now;

/** Backup archives omit _scheduled_functions. Rebuild missing timers from the
 * application outbox without replaying completed work or stealing a live lease.
 * Each mutation scans at most 50 rows and chains a durable bounded continuation. */
export const sweep = internalMutation({ args: { cursor: v.optional(v.string()) }, handler: async (ctx, { cursor }) => {
  const now = Date.now(), updatedAt = new Date(now).toISOString();
  const page = await ctx.db.query('jobs').paginate({ cursor: cursor ?? null, numItems: 50 });
  let recovered = 0, cancelled = 0, exhausted = 0;
  for (const job of page.page) {
    if (!['pending', 'running'].includes(job.state)) continue;
    if (job.state === 'running' && (job.lockedUntil ?? 0) > now) continue;
    const owner = await own(ctx, job.ownerId), session = job.sessionId ? await parent(ctx, job.sessionId) : undefined;
    const resource = job.resourceId && job.resourceKind ? await target(ctx, job) : undefined;
    if (gone(owner, now) || job.sessionId && (gone(session, now) || session.ownerId !== job.ownerId) || job.resourceId && gone(resource, now)) {
      if (job.scheduledId) await ctx.scheduler.cancel(job.scheduledId).catch(() => undefined);
      await ctx.db.patch(job._id, { state: 'cancelled', code: 'RESOURCE_DELETED', fence: job.fence + 1, workerId: undefined, lockedUntil: undefined, scheduledId: undefined, updatedAt }); cancelled++; continue;
    }
    if (job.attempts >= 3) {
      if (job.scheduledId) await ctx.scheduler.cancel(job.scheduledId).catch(() => undefined);
      await ctx.db.patch(job._id, { state: 'failed', code: 'RETRY_LIMIT', fence: job.fence + 1, workerId: undefined, lockedUntil: undefined, scheduledId: undefined, updatedAt }); exhausted++;
      if (resource && resource.revision === job.expectedRevision && ['source', 'artifact'].includes(job.resourceKind!) && ['queued', 'processing', 'running'].includes(resource.data.status)) {
        const revision = resource.revision + 1;
        await ctx.db.patch(resource._id, { revision, updatedAt, data: { ...resource.data, status: 'failed', revision, updatedAt, error: 'Background processing exhausted its bounded retry allowance. Retry this item.' } });
        await ctx.db.patch(owner._id, { revision: owner.revision + 1 });
      }
      continue;
    }
    const scheduled = job.scheduledId ? await ctx.db.system.get(job.scheduledId) : null;
    // Pending/in-progress actions already hold a durable execution path. An
    // expired worker is different: revoke its publication fence before retry.
    if (job.state === 'pending' && scheduled && ['pending', 'inProgress'].includes(scheduled.state.kind)) continue;
    if (job.scheduledId && scheduled?.state.kind === 'pending') await ctx.scheduler.cancel(job.scheduledId);
    const scheduledId = await ctx.scheduler.runAt(Math.max(now + 250, job.availableAt), run, { jobId: job.id });
    await ctx.db.patch(job._id, { state: 'pending', fence: job.fence + (job.state === 'running' ? 1 : 0), workerId: undefined, lockedUntil: undefined, scheduledId, updatedAt }); recovered++;
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('recovery:sweep'), { cursor: page.continueCursor });
  return { processed: page.page.length, recovered, cancelled, exhausted, done: page.isDone };
} });
