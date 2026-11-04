import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ConvexStore, StoreError, type Principal } from '@milli/db';
import { registerIdentity } from '../src/identity.js';
describe.skipIf(process.env.TOKAI_TEST_IDENTITY !== '1')('real local Keycloak and Convex identity', () => {
  it('completes authorization code/PKCE, transfers guest work and revokes the app cookie', async () => {
    loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url)));
    const store = ConvexStore.fromEnv(process.env), app = Fastify(), origin = 'http://localhost:3000';
    app.setErrorHandler((error, _request, reply) => { if (error instanceof StoreError) return reply.status(error.status).send({ code: error.code }); return reply.status(500).send({ code: 'FAILED' }); });
    await registerIdentity(app, { store, env: { ...process.env, APP_ORIGIN: origin, API_ORIGIN: 'http://localhost:4000' } });
    const guest = await store.createGuest(), p = await store.authenticate(guest.token), username = `tokai-test-${randomUUID()}`, password = randomBytes(24).toString('base64url');
    let adminToken = '', userUrl = '', userPrincipal: Principal | undefined;
    const request = (url: string | URL, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    try {
      const admin = await request('http://localhost:8088/realms/master/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'tokai-admin', password: process.env.KEYCLOAK_ADMIN_PASSWORD! }) }); expect(admin.status).toBe(200); adminToken = (await admin.json() as { access_token: string }).access_token;
      const created = await request('http://localhost:8088/admin/realms/tokai-local/users', { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, enabled: true, firstName: 'Local', lastName: 'Integration', email: `${username}@example.invalid`, emailVerified: true, credentials: [{ type: 'password', value: password, temporary: false }] }) }); expect(created.status).toBe(201); userUrl = created.headers.get('location')!;
      await store.resources.put(p, 'preferences', p.ownerId, { goal: 'Preserve my guest goal' }, { expectedRevision: -1 });
      const sourceId = randomUUID(), embedding = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0); await store.resources.put(p, 'source', sourceId, { title: 'Claimed source' }, { expectedRevision: -1 }); await store.chunks.replace(p, sourceId, 0, [{ id: randomUUID(), sourceId, revision: 0, ordinal: 0, text: 'sunlight photosynthesis', embedding }]);
      const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin, authorization: `Bearer ${guest.token}` } }); expect(login.statusCode).toBe(200);
      const bindingCookie = (login.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
      const keycloakCookies = new Map<string, string>();
      const capture = (response: Response) => { for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0]!, index = pair.indexOf('='); keycloakCookies.set(pair.slice(0, index), pair); } };
      const authorize = await request(login.json().url); capture(authorize); expect(authorize.status).toBe(200);
      const page = await authorize.text(), tag = page.match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/)?.[0], action = tag?.match(/\baction="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&'); expect(action).toBeDefined();
      const submitted = await request(action!, { method: 'POST', headers: { Cookie: [...keycloakCookies.values()].join('; '), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, credentialId: '' }) }); expect(submitted.status).toBe(302);
      const location = new URL(submitted.headers.get('location')!); expect(location.origin).toBe('http://localhost:4000');
      const callback = await app.inject({ url: location.pathname + location.search, headers: { cookie: bindingCookie } }); expect(callback.statusCode).toBe(302);
      const appCookie = (callback.headers['set-cookie'] as string[]).find(value => value.startsWith('tokai_session='))!.split(';')[0]!;
      const me = await app.inject({ url: '/v1/me', headers: { cookie: appCookie, authorization: `Bearer ${guest.token}` } }); expect(me.json()).toMatchObject({ identity: { kind: 'user' }, preferences: { goal: 'Preserve my guest goal' } });
      userPrincipal = await store.authenticate(decodeURIComponent(appCookie.slice('tokai_session='.length))); expect((await store.chunks.search(userPrincipal, { sourceIds: [sourceId], embedding }))[0]?.sourceId).toBe(sourceId);
      await expect(store.authenticate(guest.token)).rejects.toMatchObject({ status: 401 });
      expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: appCookie, origin } })).statusCode).toBe(204); expect((await app.inject({ url: '/v1/me', headers: { cookie: appCookie } })).json().identity.kind).toBe('anonymous');
    } finally {
      if (userPrincipal) await store.deleteOwner(await store.principalForOwner(userPrincipal.ownerId)); else await store.deleteOwner(p).catch(() => undefined);
      if (userUrl && adminToken) { const removed = await request(userUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } }); expect(removed.status).toBe(204); }
      await app.close(); await store.close();
    }
  }, 60000);
});
