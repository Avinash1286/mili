import { JobExecutionSchema } from '@milli/contracts';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Artifact, Source } from '@milli/contracts';
import { StoreError, type JobRecord } from '@milli/db';
import { parse, metered, type ProductContext } from './product-context.js';
import { runSource } from './source-routes.js';
import { runArtifact } from './artifact-jobs.js';
import { requestSignal } from './request-lifecycle.js';

export async function registerJobs(app: FastifyInstance, context: ProductContext) {
  const active = new Map<string, AbortController>();
  const authorized = (value: string | undefined) => {
    const expected = context.env.TOKAI_JOB_SECRET;
    return Boolean(expected && value && Buffer.byteLength(expected) === Buffer.byteLength(value) && timingSafeEqual(Buffer.from(expected), Buffer.from(value)));
  };
  app.post('/internal/jobs/execute', { bodyLimit: 2048, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!authorized(typeof request.headers['x-tokai-job-secret'] === 'string' ? request.headers['x-tokai-job-secret'] : undefined)) throw new StoreError(401, 'UNAUTHORIZED', 'A valid job credential is required.');
    const input = parse(JobExecutionSchema, request.body);
    const job = await context.store.outbox.get(input.jobId);
    if (!job || job.state !== 'running' || job.workerId !== input.workerId || job.fence !== input.fence || !job.lockedUntil || Date.parse(job.lockedUntil) <= Date.parse(context.now())) throw new StoreError(409, 'STALE_JOB', 'This job lease is no longer active.');
    if (active.has(job.id) || active.size >= 2) throw new StoreError(429, 'WORKER_BUSY', 'The local worker is at capacity.');
    const controller = new AbortController(); active.set(job.id, controller);
    const parentSignal = requestSignal(request), abort = () => controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    if (parentSignal.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 135000);
    const heartbeat = setInterval(() => { void context.store.outbox.renew(job.id, input.workerId, input.fence, 120000).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()); }, 15000);
    try {
      const p = await context.store.principalForOwner(job.ownerId);
      if (job.kind === 'source') {
        const source = await context.store.resources.get<Source>(p, 'source', job.resourceId!);
        await metered(context, p, 'ingestion', source.data.bytes, () => runSource(context, p, job, controller.signal), { traceId: job.id });
      }
      else if (job.kind === 'artifact') await runArtifact(context, p, job, controller.signal);
      else throw new StoreError(400, 'UNKNOWN_JOB', 'This job type is unavailable.');
      controller.signal.throwIfAborted();
      return reply.send({ completed: true });
    } catch (error) {
      if (job.attempts >= 3) await markFailed(context, job, error).catch(() => undefined);
      throw error instanceof StoreError ? error : new StoreError(503, 'JOB_FAILED', 'Background processing could not complete. Retry the failed item.');
    } finally { parentSignal.removeEventListener('abort', abort); clearInterval(heartbeat); clearTimeout(timeout); active.delete(job.id); }
  });
  app.addHook('preClose', async () => { for (const controller of active.values()) controller.abort(); });
  return { cancelOwner: async (ownerId: string) => { for (const [id, controller] of active) if ((await context.store.outbox.get(id))?.ownerId === ownerId) controller.abort(); } };
}
async function markFailed(context: ProductContext, job: JobRecord, failure: unknown) {
  if (!job.resourceKind || !job.resourceId) return;
  const p = await context.store.principalForOwner(job.ownerId);
  await context.store.locked(`job:${job.id}`, async () => {
    await context.store.assertJob({ id: job.id, workerId: job.workerId!, fence: job.fence });
    const current = await context.store.outbox.get(job.id);
    if (!current || current.workerId !== job.workerId || current.fence !== job.fence || current.state !== 'running') return;
    const record = await context.store.resources.get<Source | Artifact>(p, job.resourceKind!, job.resourceId!);
    if (record.data.status === 'ready' || record.revision !== job.expectedRevision) return;
    const message = failure instanceof StoreError && ['DAILY_USAGE_LIMIT', 'WORK_CAPACITY'].includes(failure.code) ? failure.message : 'Processing failed after three bounded attempts. Check the source/provider configuration, then retry.';
    await context.store.resources.put(p, record.kind, record.id, { ...record.data, status: 'failed', revision: record.data.revision + 1, updatedAt: context.now(), error: message }, { expectedRevision: record.revision, sessionId: record.sessionId });
  });
}
