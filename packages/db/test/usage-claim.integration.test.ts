import { describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ConvexStore, ServiceTransport, type Principal } from '../src/index.js';
import { lesson } from './fixtures.js';

describe.skipIf(process.env.TOKAI_TEST_CONVEX !== '1')('native Convex usage ownership transfer', () => {
  it('preserves combined spend, settles an in-flight guest request once, and revokes guest access', async () => {
    loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url)));
    const transport = ServiceTransport.fromEnv(process.env), store = new ConvexStore({ transport });
    const guest = await store.authenticate((await store.createGuest()).token);
    const { principal: user } = await store.createUser({ issuer: 'urn:tokai:integration', subject: randomUUID() });
    const lessonValue = lesson(), ongoing = randomUUID(); let claimed = false;
    const reserve = (principal: Principal, id: string, units: number, sessionId?: string) => transport.call('mutation', 'usage:reserve', { principal, id, kind: 'model', units, sessionId });
    const finish = (ownerId: string, id: string, usedUnits: number, inputTokens: number) => transport.call('mutation', 'usage:finish', { ownerId, id, success: true, usedUnits, observation: { inputTokens } });
    const summary = async (principal: Principal, sessionId?: string) => (await transport.call<any>('query', 'usage:summary', { principal, sessionId })).kinds.find((item: any) => item.kind === 'model');
    try {
      await store.create(guest, lessonValue);
      const old = randomUUID(), existing = randomUUID();
      await reserve(guest, old, 2, lessonValue.id); await finish(guest.ownerId, old, 2, 7);
      await reserve(user, existing, 5); await finish(user.ownerId, existing, 5, 13);
      await reserve(guest, ongoing, 4, lessonValue.id);
      await store.claimGuest(guest, user); claimed = true;
      expect(await summary(user)).toMatchObject({ used: 11, active: 1, totals: { requests: 3, succeeded: 2, inputTokens: 20 } });
      expect(await summary(user, lessonValue.id)).toMatchObject({ used: 6, active: 1, totals: { requests: 2, succeeded: 1, inputTokens: 7 } });
      await expect(summary(guest)).rejects.toMatchObject({ status: 401 });
      await finish(guest.ownerId, ongoing, 3, 11);
      const settled = await summary(user);
      expect(settled).toMatchObject({ used: 10, active: 0, totals: { requests: 3, succeeded: 3, inputTokens: 31 } });
      expect(await summary(user, lessonValue.id)).toMatchObject({ used: 5, totals: { requests: 2, succeeded: 2, inputTokens: 18 } });
      await finish(guest.ownerId, ongoing, 1, 1000); await finish(user.ownerId, ongoing, 1, 1000);
      expect(await summary(user)).toEqual(settled);
    } finally {
      if (!claimed) await store.deleteOwner(guest); await store.deleteOwner(user); await store.close();
    }
  }, 30000);
});
