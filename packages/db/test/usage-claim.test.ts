import { expect, it } from 'vitest';
import { claimUsage } from '../../../convex/usage.js';

it('a guest claim merges private evidence without recounting global spend or changing another owner', async () => {
  const tables: Record<string, any[]> = {
    usageDays: [
      { _id: 'global', scope: 'global', day: '2026-11-04', kind: 'model', totals: { units: 9, requests: 3, succeeded: 2, failed: 0, inputTokens: 25 } },
      { _id: 'guest', scope: 'owner:guest', day: '2026-11-04', kind: 'model', totals: { units: 4, requests: 1, succeeded: 0, failed: 0 } },
      { _id: 'user', scope: 'owner:user', day: '2026-11-04', kind: 'model', totals: { units: 3, requests: 1, succeeded: 1, failed: 0, inputTokens: 20 } },
      { _id: 'lesson', scope: 'session:guest/lesson', day: '2026-11-04', kind: 'model', totals: { units: 4, requests: 1, succeeded: 0, failed: 0 } },
      { _id: 'other', scope: 'owner:guest-extra', day: '2026-11-04', kind: 'model', totals: { units: 2, requests: 1, succeeded: 1, failed: 0, inputTokens: 5 } },
      { _id: 'other-lesson', scope: 'session:guest-extra/lesson', day: '2026-11-04', kind: 'model', totals: { units: 2, requests: 1, succeeded: 1, failed: 0, inputTokens: 5 } },
    ],
    usageReservations: [{ _id: 'running', id: 'request', ownerId: 'guest', state: 'running', units: 4, sessionId: 'lesson' }],
    files: [{ _id: 'private-file', ownerId: 'guest', key: 'source/lesson', size: 20 }],
    usageStorage: [{ _id: 'inventory-guest', ownerId: 'guest', bytes: 20, objects: 1 }, { _id: 'inventory-user', ownerId: 'user', bytes: 5, objects: 1 }, { _id: 'inventory-global', ownerId: 'global', bytes: 25, objects: 2 }],
  };
  const protectedBefore = structuredClone(tables.usageDays!.filter(row => ['global', 'other', 'other-lesson'].includes(row._id)));
  const ctx = { db: {
    query(table: string) { return { withIndex(_name: string, build: (q: any) => void) {
      const predicates: ((row: any) => boolean)[] = [], q: any = {};
      for (const operation of ['eq', 'gte', 'lt']) q[operation] = (key: string, value: any) => { predicates.push(row => operation === 'eq' ? row[key] === value : operation === 'gte' ? row[key] >= value : row[key] < value); return q; };
      build(q); const rows = () => tables[table]!.filter(row => predicates.every(test => test(row)));
      return { take: async (n: number) => rows().slice(0, n), unique: async () => rows()[0] ?? null };
    } }; },
    async patch(id: string, update: any) { Object.assign(Object.values(tables).flat().find(row => row._id === id), update); },
    async delete(id: string) { for (const [table, rows] of Object.entries(tables)) tables[table] = rows.filter(row => row._id !== id); },
  } };
  await claimUsage(ctx, 'guest', 'user');
  expect(tables.usageDays!.filter(row => ['global', 'other', 'other-lesson'].includes(row._id))).toEqual(protectedBefore);
  expect(tables.usageDays!.find(row => row.scope === 'owner:user')?.totals).toEqual({ units: 7, requests: 2, succeeded: 1, failed: 0, inputTokens: 20, unboundedRequests: 2 });
  expect(tables.usageDays!.find(row => row._id === 'lesson')?.scope).toBe('session:user/lesson');
  expect(tables.usageReservations![0]).toMatchObject({ ownerId: 'user', settlementOwnerId: 'guest', state: 'running', units: 4 });
  expect(tables.usageDays!.some(row => row.scope === 'owner:guest')).toBe(false);
  expect(tables.files![0].ownerId).toBe('user');
  expect(tables.usageStorage!.find(row => row.ownerId === 'user')).toMatchObject({ bytes: 25, objects: 2 });
  expect(tables.usageStorage!.find(row => row.ownerId === 'global')).toEqual({ _id: 'inventory-global', ownerId: 'global', bytes: 25, objects: 2 });
});
