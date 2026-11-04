import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConvexStore, StoreError, type Principal } from '@tokai/db';
import { UsageMeter, type UsageLease } from '../src/usage.js';
import { createLesson } from '@tokai/tutor-core';
import { randomUUID } from 'node:crypto';

describe.skipIf(process.env.TOKAI_TEST_CONVEX !== '1')('actual Convex usage admission', () => {
  let first: ConvexStore, second: ConvexStore; const principals: Principal[] = [], leases: UsageLease[] = [];
  beforeAll(async () => {
    loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url)));
    first = ConvexStore.fromEnv(process.env); second = ConvexStore.fromEnv(process.env); await first.initialize();
    for (let i = 0; i < 5; i++) principals.push(await first.authenticate((await first.createGuest()).token));
  });
  afterAll(async () => { for (const lease of leases) await lease.finish(true, 0); for (const p of principals) await first.deleteOwner(p).catch(error => { if (!(error instanceof StoreError && error.status === 401)) throw error; }); await first?.close(); await second?.close(); });
  it('enforces atomic global/owner limits across independent clients and consumes settlement once', async () => {
    const one = new UsageMeter(first, {}), two = new UsageMeter(second, {});
    leases.push(await one.begin(principals[0]!, 'model', 1));
    await expect(two.begin(principals[0]!, 'model', 1)).rejects.toMatchObject({ code: 'WORK_CAPACITY' });
    for (const p of principals.slice(1, 4)) leases.push(await two.begin(p, 'model', 1));
    await expect(one.begin(principals[4]!, 'model', 1)).rejects.toMatchObject({ code: 'WORK_CAPACITY' });
    await leases[0]!.finish(true, 0, { totalTokens: 7 });
    await first.transport.call('mutation', 'usage:finish', { id: leases[0]!.id, ownerId: principals[0]!.ownerId, success: true, usedUnits: 0, observation: { totalTokens: 7 } });
    leases.push(await one.begin(principals[4]!, 'model', 1));
    const result = await two.summary(principals[0]!); expect(result.kinds[0]).toMatchObject({ active: 0, used: 0, totals: { totalTokens: 7, succeeded: 1 } });
    await first.deleteOwner(principals[4]!);
    await expect(two.begin(principals[4]!, 'speech', 1)).rejects.toMatchObject({ status: 401 });
  });
  it('persists dated estimates in owner/session scopes and rejects another owner', async () => {
    for (const lease of leases) await lease.finish(true, 0);
    const p = principals[0]!, session = createLesson({ id: randomUUID(), topic: 'fractions', mode: 'sample', messageId: randomUUID(), now: new Date().toISOString() });
    await first.create(p, session);
    const usage = new UsageMeter(first, { TOKAI_USAGE_RATES_JSON: JSON.stringify({ effectiveDate: '2026-11-04', speechPerMillionCharacters: 10 }) });
    const lease = await usage.begin(p, 'speech', 1000, { sessionId: session.id }); leases.push(lease); await lease.finish(true, 1000, { audioMs: 5000 });
    const result = await new UsageMeter(second, {}).summary(p, session.id); expect(result.estimatedUsd).toBeCloseTo(.01); expect(result.priceDate).toBe('2026-11-04');
    expect(result.kinds[1]!.totals).toMatchObject({ units: 1000, pricedRequests: 1 });
    expect((await usage.summary(p)).estimatedUsd).toBeCloseTo(.01);
    await expect(usage.summary(principals[1]!, session.id)).rejects.toMatchObject({ status: 404 });
  });
});
