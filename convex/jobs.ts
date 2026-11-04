import { internalActionGeneric as internalAction, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { jobRetry } from './job_policy';

/** Convex owns durable scheduling, retries and receipts. Native OCR/audio work runs in the bounded API executor. */
export const run = internalAction({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    const workerId = crypto.randomUUID();
    const job = await ctx.runMutation(makeFunctionReference<'mutation'>('store:jobAcquire'), { jobId, workerId, leaseMs: 180_000 }) as { fence: number; attempts: number } | null;
    if (!job) return;
    let status: number | undefined, failureCode: string | undefined;
    try {
      const base = process.env.INTERNAL_API_URL, secret = process.env.TOKAI_JOB_SECRET;
      if (!base || !secret) throw new Error('EXECUTOR_NOT_CONFIGURED');
      const endpoint = new URL('/internal/jobs/execute', base);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('INVALID_EXECUTOR');
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-milli-Job-Secret': secret };
      // An optional project-scoped Vercel automation token opens only the fixed
      // executor destination; the application callback secret is still required.
      if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150_000),
        headers, body: JSON.stringify({ jobId, workerId, fence: job.fence }) });
      if (!response.ok) {
        status = response.status;
        const body = await response.json().catch(() => ({})) as { code?: unknown };
        failureCode = body.code === 'DAILY_USAGE_LIMIT' ? body.code : undefined;
        throw new Error('JOB_EXECUTION_FAILED');
      }
      await ctx.runMutation(makeFunctionReference<'mutation'>('store:jobComplete'), { jobId, workerId, fence: job.fence });
    } catch {
      // Bounded retries; a durable recovery timer also handles an action dying before this catch.
      const retry = jobRetry(job.attempts, status, failureCode), retryAt = retry.delayMs === undefined ? undefined : new Date(Date.now() + retry.delayMs).toISOString();
      await ctx.runMutation(makeFunctionReference<'mutation'>('store:jobFail'), { jobId, workerId, fence: job.fence, ...(retryAt ? { retryAt } : {}), code: retry.code }).catch(() => undefined);
    }
  },
});
