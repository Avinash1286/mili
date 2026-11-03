import { describe, expect, it, vi } from 'vitest';
import { jobAcquire, jobFail } from '../../../convex/store.js';

function fixture(resourceRevision = 0, status = 'queued') {
  const owner = { _id: 'owner-row', id: 'owner', kind: 'user', revision: 4 };
  const resource = { _id: 'resource-row', id: 'source', kind: 'source', ownerId: 'owner', revision: resourceRevision, data: { status, revision: resourceRevision } };
  const job = { _id: 'job-row', id: 'job', ownerId: 'owner', kind: 'source', resourceKind: 'source', resourceId: 'source', expectedRevision: 0, state: 'running', attempts: 3, fence: 3, workerId: 'worker', lockedUntil: Date.now() + 30000, availableAt: Date.now() - 1000 };
  const rows: Record<string, any> = { owners: owner, resources: resource, jobs: job };
  const context = { db: { query: (table: string) => ({ withIndex: () => ({ unique: async () => rows[table] }) }), patch: vi.fn(async (id: string, patch: object) => Object.assign(Object.values(rows).find(row => row._id === id), patch)) }, scheduler: { runAt: vi.fn(async () => 'scheduled') } };
  return { context, owner, resource, job };
}
describe('durable executor failure', () => {
  it('marks the queued source failed even when no API callback ran', async () => {
    const f = fixture(); await (jobFail as any)._handler(f.context, { jobId: 'job', workerId: 'worker', fence: 3, code: 'JOB_EXECUTION_FAILED' });
    expect(f.job).toMatchObject({ state: 'failed', workerId: undefined, lockedUntil: undefined });
    expect(f.resource).toMatchObject({ revision: 1, data: { revision: 1, status: 'failed' } }); expect(f.owner.revision).toBe(5); expect(f.context.scheduler.runAt).not.toHaveBeenCalled();
  });
  it('recovers a third crashed worker lease and preserves superseding output', async () => {
    const abandoned = fixture(); abandoned.job.lockedUntil = Date.now() - 1;
    await (jobAcquire as any)._handler(abandoned.context, { jobId: 'job', workerId: 'recovery', leaseMs: 30000 }); expect(abandoned.resource.data.status).toBe('failed');
    const newer = fixture(1, 'ready'); await (jobFail as any)._handler(newer.context, { jobId: 'job', workerId: 'worker', fence: 3, code: 'JOB_EXECUTION_FAILED' }); expect(newer.resource.data.status).toBe('ready'); expect(newer.owner.revision).toBe(4);
  });
  it('rejects an obsolete fence before touching the resource', async () => {
    const f = fixture(); await expect((jobFail as any)._handler(f.context, { jobId: 'job', workerId: 'worker', fence: 2, code: 'JOB_EXECUTION_FAILED' })).rejects.toBeDefined(); expect(f.context.db.patch).not.toHaveBeenCalled();
  });
});
