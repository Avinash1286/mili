import { internalActionGeneric as internalAction, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

/** Convex owns durable scheduling, retries and receipts. Native OCR/audio work runs in the bounded API executor. */
export const run = internalAction({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    const workerId = crypto.randomUUID();
    const job = await ctx.runMutation(makeFunctionReference<'mutation'>('store:jobAcquire'), { jobId, workerId, leaseMs: 180_000 }) as { fence: number; attempts: number } | null;
    if (!job) return;
    try {
      const base = process.env.INTERNAL_API_URL, secret = process.env.TOKAI_JOB_SECRET;
      if (!base || !secret) throw new Error('EXECUTOR_NOT_CONFIGURED');
      const endpoint = new URL('/internal/jobs/execute', base);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('INVALID_EXECUTOR');
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150_000),
        headers: { 'Content-Type': 'application/json', 'X-Tokai-Job-Secret': secret }, body: JSON.stringify({ jobId, workerId, fence: job.fence }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'JOB_STALE' : 'JOB_EXECUTION_FAILED');
      await ctx.runMutation(makeFunctionReference<'mutation'>('store:jobComplete'), { jobId, workerId, fence: job.fence });
    } catch {
      // Bounded retries; a durable recovery timer also handles an action dying before this catch.
      const retryAt = job.attempts < 3 ? new Date(Date.now() + [2000, 15000][job.attempts - 1]!).toISOString() : undefined;
      await ctx.runMutation(makeFunctionReference<'mutation'>('store:jobFail'), { jobId, workerId, fence: job.fence, ...(retryAt ? { retryAt } : {}), code: 'JOB_EXECUTION_FAILED' }).catch(() => undefined);
    }
  },
});
