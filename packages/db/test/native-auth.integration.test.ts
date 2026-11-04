import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { ConvexNativeIdentity, ConvexStore } from '../src/index.js';

describe.skipIf(process.env.TOKAI_TEST_CONVEX !== '1')('actual local Better Auth identity', () => {
  beforeAll(() => loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url))));
  it('uses library passwords, rejects wrong credentials, validates revocation and deletes the account', async () => {
    const origin = 'http://localhost:3000', site = 'http://127.0.0.1:3211';
    const email = `tokai-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('base64url');
    const auth = new ConvexNativeIdentity(process.env), store = ConvexStore.fromEnv(process.env); await store.initialize();
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${site}/api/auth${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const signup = await post('/sign-up/email', { email, password, name: 'Isolated auth verification' });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(cookie).toContain('session_token=');
    const tokenResponse = await fetch(`${site}/api/auth/convex/token`, { headers: { Cookie: cookie, Origin: origin }, signal: AbortSignal.timeout(10000) });
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json() as { token: string };
    const identity = await auth.verify(token);
    const user = await store.createUser({ issuer: 'urn:tokai:native-auth', subject: identity.subject });
    try {
      expect(identity.emailVerified).toBe(false); expect(await auth.active(identity)).toBe(true);
      expect((await post('/sign-in/email', { email, password: 'wrong-password-value' })).status).toBe(401);
      expect((await post('/sign-out', {}, cookie)).status).toBe(200);
      expect(await auth.active(identity)).toBe(false); await expect(auth.verify(token)).rejects.toMatchObject({ status: 401 });
      const signin = await post('/sign-in/email', { email, password }); expect(signin.status).toBe(200);
      const nextCookie = signin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const next = await fetch(`${site}/api/auth/convex/token`, { headers: { Cookie: nextCookie, Origin: origin } }); const nextToken = (await next.json() as { token: string }).token;
      const nextIdentity = await auth.verify(nextToken); expect(nextIdentity.subject).toBe(identity.subject);
      await store.deleteOwner(user.principal);
      for (let index = 0; index < 50 && await auth.active(nextIdentity); index++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(await auth.active(nextIdentity)).toBe(false);
      expect((await post('/sign-in/email', { email, password })).status).toBe(401);
    } finally { await store.deleteOwner(user.principal).catch(error => { if (error.status !== 401 && error.status !== 404) throw error; }); await store.close(); }
  }, 60000);
});
