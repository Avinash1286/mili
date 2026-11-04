import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { FileStore, StoreError } from '@milli/db';
import { registerIdentity } from '../src/identity.js';
import { createApp } from '../src/app.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const cookies = (response: { headers: Record<string, unknown> }) => (Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] as string[] : [String(response.headers['set-cookie'])]).map(value => value.split(';')[0]!).join('; ');
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-identity-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStore(directory); await store.initialize(); const guest = await store.createGuest(), p = await store.authenticate(guest.token);
  const keys = await generateKeyPair('RS256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
  let issuer = '', nonce = '', challenge = '', tokenRequests = 0, wrongNonce = false;
  const server: Server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/.well-known/openid-configuration') return response.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    if (request.url === '/jwks') return response.end(JSON.stringify({ keys: [jwk] }));
    if (request.url === '/token') {
      tokenRequests++; let raw = ''; for await (const chunk of request) raw += chunk.toString(); const form = new URLSearchParams(raw);
      if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) { response.statusCode = 400; return response.end('{}'); }
      const token = await new SignJWT({ nonce: wrongNonce ? 'wrong' : nonce, name: 'Local Learner' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(issuer).setAudience('tokai-test').setSubject('account-one').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
      return response.end(JSON.stringify({ id_token: token }));
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))); issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { APP_ORIGIN: 'http://localhost:3000', API_ORIGIN: 'http://localhost:4000', OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'tokai-test', SESSION_SECRET: 'test-fixture-secret-32-bytes-long-enough' };
  const app: FastifyInstance = Fastify(); cleanups.push(() => app.close()); app.setErrorHandler((error, _request, reply) => { if (error instanceof StoreError) return reply.status(error.status).send({ code: error.code }); return reply.status(500).send({ code: 'FAILED' }); });
  const closeOwner = vi.fn(async () => undefined); await registerIdentity(app, { store, env, closeOwner }); app.post('/test/private', async request => ({ principal: await store.authenticate(request.headers.authorization?.slice(7)) }));
  async function login() { const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: env.APP_ORIGIN, authorization: `Bearer ${guest.token}` } }); expect(response.statusCode).toBe(200); const url = new URL(response.json().url); nonce = url.searchParams.get('nonce')!; challenge = url.searchParams.get('code_challenge')!; return { url, cookie: cookies(response) }; }
  return { app, store, guest, p, env, login, closeOwner, tokenRequests: () => tokenRequests, wrongNonce: () => { wrongNonce = true; } };
}
describe('OIDC identity boundary', () => {
  it('keeps cookie credentials out of source upload responses while preserving guest uploads', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tokai-cookie-upload-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new FileStore(directory), origin = 'http://localhost:3000';
    const app = await createApp({ store, dataDir: directory, env: { APP_ORIGIN: origin }, rateLimit: false }); cleanups.push(() => app.close());
    const account = await store.createUser({ issuer: 'https://fixture.example', subject: 'upload-account' }), guest = await store.createGuest();
    const bytes = Buffer.from('A leaf uses sunlight to produce sugar.'), payload = { title: 'Upload fixture', filename: 'notes.txt', mimeType: 'text/plain', bytes: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') };
    const cookie = `tokai_session=${account.token}`;
    const response = await app.inject({ method: 'POST', url: '/v1/sources/uploads', headers: { cookie, origin, authorization: `Bearer ${guest.token}` }, payload });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().headers).toEqual({ 'Content-Type': 'text/plain' }); expect(response.body).not.toContain(account.token); expect(response.body).not.toContain(guest.token);
    const uploaded = await app.inject({ method: 'PUT', url: `/v1/sources/${response.json().source.id}/content`, headers: { cookie, origin, 'content-type': 'text/plain' }, payload: bytes }); expect(uploaded.statusCode, uploaded.body).toBe(204);
    const guestResponse = await app.inject({ method: 'POST', url: '/v1/sources/uploads', headers: { authorization: `Bearer ${guest.token}` }, payload }); expect(guestResponse.json().headers.Authorization).toBe(`Bearer ${guest.token}`);
    expect((await app.inject({ method: 'POST', url: '/v1/sources/uploads', headers: { cookie, origin: 'https://outside.test' }, payload })).statusCode).toBe(403);
  });
  it('projects anonymous/guest identity without secrets', async () => { const { app, guest } = await setup(); const anonymous = await app.inject('/v1/me'); expect(anonymous.json()).toMatchObject({ identity: { kind: 'anonymous', signInAvailable: true }, revision: -1 }); const response = await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${guest.token}` } }); expect(response.json().identity.kind).toBe('guest'); expect(response.body).not.toContain(guest.token); });
  it('verifies PKCE/signature/nonce, claims guest preferences, and revokes account cookie on logout', async () => {
    const { app, store, guest, p, env, login, closeOwner } = await setup(); await store.resources.put(p, 'preferences', p.ownerId, { goal: 'Keep this goal' }, { expectedRevision: -1 });
    const start = await login(), callback = await app.inject({ url: `/auth/callback?state=${start.url.searchParams.get('state')}&code=valid`, headers: { cookie: start.cookie } }); expect(callback.statusCode).toBe(302); expect(callback.headers.location).toBe('http://localhost:3000/dashboard');
    const accountCookies = cookies(callback), me = await app.inject({ url: '/v1/me', headers: { cookie: accountCookies, authorization: `Bearer ${guest.token}` } }); expect(me.json()).toMatchObject({ identity: { kind: 'user', displayName: 'Local Learner' }, preferences: { goal: 'Keep this goal' } }); await expect(store.authenticate(guest.token)).rejects.toMatchObject({ status: 401 }); expect(closeOwner).toHaveBeenCalledWith(p.ownerId);
    const forbidden = await app.inject({ method: 'POST', url: '/test/private', headers: { cookie: accountCookies, origin: 'https://outside.test' } }); expect(forbidden.statusCode).toBe(403);
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: accountCookies, origin: env.APP_ORIGIN } }); expect(logout.statusCode).toBe(204); expect((await app.inject({ url: '/v1/me', headers: { cookie: accountCookies } })).json().identity.kind).toBe('anonymous');
  });
  it('rejects missing browser binding and consumes state before an invalid token can be replayed', async () => {
    const value = await setup(), start = await value.login(), url = `/auth/callback?state=${start.url.searchParams.get('state')}&code=valid`;
    expect((await value.app.inject(url)).statusCode).toBe(400); expect(value.tokenRequests()).toBe(0);
    value.wrongNonce(); const bad = await value.app.inject({ url, headers: { cookie: start.cookie } }); expect(bad.statusCode).toBe(400); expect(bad.json().code).toBe('OIDC_TOKEN_INVALID');
    expect((await value.app.inject({ url, headers: { cookie: start.cookie } })).statusCode).toBe(404); expect(value.tokenRequests()).toBe(1);
  });
});
