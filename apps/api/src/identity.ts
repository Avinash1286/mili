import { NativeSessionRequestSchema } from '@milli/contracts';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { LearnerPreferencesSchema, IdentitySchema } from '@milli/contracts';
import { ConvexNativeIdentity, StoreError, type Store, type Principal, type NativeIdentityProvider } from '@milli/db';
import { preferences, parse } from './product-context.js';
const sessionCookie = 'tokai_session', loginCookie = 'tokai_login';
const cookieRequests = new WeakSet<FastifyRequest>();
export const usesAccountCookie = (request: FastifyRequest) => cookieRequests.has(request);
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
type LoginState = { verifier: string; nonce: string; expiresAt: number; original: Principal };
export type IdentityOptions = { store: Store; env: Record<string, string | undefined>; closeOwner?: (ownerId: string) => Promise<void>; fetch?: typeof fetch; now?: () => number; nativeIdentity?: NativeIdentityProvider };
type NativeSession = { subject: string; sessionId: string };
export async function deleteNativeIdentity(principal: Principal, env: Record<string, string | undefined>) {
  if (env.TOKAI_NATIVE_AUTH === '1') await new ConvexNativeIdentity(env).deleteAccount(principal);
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
function cookie(request: FastifyRequest, name: string) { const values = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(name + '=')); if (!values || values.length !== 1) return undefined; try { return decodeURIComponent(values[0]!.slice(name.length + 1)); } catch { return undefined; } }
function setCookie(reply: FastifyReply, name: string, value: string, maxAge: number, secure: boolean) { const previous = reply.getHeader('Set-Cookie'), next = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`; reply.header('Set-Cookie', [...(Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : []), next]); }
export function clearIdentityCookies(reply: FastifyReply, env: Record<string, string | undefined>) { const secure = (env.API_ORIGIN ?? '').startsWith('https:'); setCookie(reply, sessionCookie, '', 0, secure); setCookie(reply, loginCookie, '', 0, secure); }
export function requestPrincipal(request: FastifyRequest, store: Store) { return store.authenticate(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined); }
export async function registerIdentity(app: FastifyInstance, options: IdentityOptions) {
  const { store, env } = options, now = options.now ?? Date.now, requestFetch = options.fetch ?? fetch;
  const origin = env.APP_ORIGIN ?? 'http://localhost:3000', apiOrigin = env.API_ORIGIN ?? `http://localhost:${env.API_PORT ?? '4000'}`, secure = apiOrigin.startsWith('https:');
  const available = Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);
  const native = options.nativeIdentity ?? (env.TOKAI_NATIVE_AUTH === '1' ? new ConvexNativeIdentity(env) : undefined);
  let discoveryPromise: Promise<Discovery> | undefined;
  const endpoint = (value: string) => { const url = new URL(value); if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new StoreError(503, 'OIDC_CONFIGURATION', 'Sign-in requires a trusted identity server.'); return url; };
  async function discovery() {
    discoveryPromise ??= (async () => {
      const issuer = env.OIDC_ISSUER!, url = endpoint(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
      const response = await requestFetch(url, { signal: AbortSignal.timeout(7000), redirect: 'error' });
      if (!response.ok) throw new StoreError(503, 'OIDC_UNAVAILABLE', 'The sign-in service is temporarily unavailable.');
      const value = await response.json() as Discovery;
      if (value.issuer !== issuer || !value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri) throw new StoreError(503, 'OIDC_CONFIGURATION', 'The sign-in service has an invalid configuration.');
      endpoint(value.authorization_endpoint); endpoint(value.token_endpoint); endpoint(value.jwks_uri); return value;
    })().catch(error => { discoveryPromise = undefined; throw error; }); return discoveryPromise;
  }
  const sign = (payload: string) => createHmac('sha256', env.SESSION_SECRET!).update(payload).digest('base64url');
  const requireOrigin = (request: FastifyRequest) => { if (request.headers.origin !== origin) throw new StoreError(403, 'INVALID_ORIGIN', 'This request must come from the milli application.'); };
  app.addHook('onRequest', async (request, reply) => {
    const token = cookie(request, sessionCookie); if (!token) return;
    try {
      const principal = await store.authenticate(token);
      const binding = await store.resources.get<NativeSession>(principal, 'native-session', principal.authSessionId).catch(error => { if (error instanceof StoreError && error.status === 404) return undefined; throw error; });
      if (binding && (!native || !await native.active(binding.data))) { await store.revoke(principal); throw new StoreError(401, 'ACCOUNT_SESSION_EXPIRED', 'Sign in again.'); }
      // A completed account sign-in supersedes a stale guest bearer left in a tab.
      // Cookie authority still requires Origin even when a Bearer header is present.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireOrigin(request);
      request.headers.authorization = `Bearer ${token}`;
      cookieRequests.add(request);
    }
    catch (error) { if (!(error instanceof StoreError && error.status === 401)) throw error; setCookie(reply, sessionCookie, '', 0, secure); }
  });
  app.get('/v1/me', async request => {
    let principal: Principal | undefined;
    if (request.headers.authorization) { try { principal = await requestPrincipal(request, store); } catch (error) { if (!(error instanceof StoreError && error.status === 401)) throw error; } }
    if (!principal) return { identity: IdentitySchema.parse({ kind: 'anonymous', signInAvailable: available || Boolean(native) }), preferences: LearnerPreferencesSchema.parse({}), revision: -1 };
    const record = await preferences(store, principal);
    return { identity: IdentitySchema.parse({ kind: principal.kind, displayName: record.preferences.displayName || undefined, expiresAt: principal.expiresAt, signInAvailable: available || Boolean(native) }), ...record };
  });
  app.get('/auth/config', async () => ({ native: Boolean(native), oidc: available, passwordRecovery: false, emailVerification: false }));
  app.post('/auth/native-session', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requireOrigin(request); if (!native) throw new StoreError(503, 'NATIVE_AUTH_UNAVAILABLE', 'Account sign-in is not configured.');
    const { token } = parse(NativeSessionRequestSchema, request.body);
    const identity = await native.verify(token);
    const original = request.headers.authorization ? await requestPrincipal(request, store) : undefined;
    const user = await store.createUser({ issuer: 'urn:tokai:native-auth', subject: identity.subject, displayName: identity.displayName });
    try {
      if (original?.kind === 'guest') { await options.closeOwner?.(original.ownerId); await store.claimGuest(original, user.principal); }
      await store.resources.put(user.principal, 'native-session', user.principal.authSessionId, { subject: identity.subject, sessionId: identity.sessionId }, { expectedRevision: -1 });
      const record = await preferences(store, user.principal);
      if (!record.preferences.displayName && identity.displayName) await store.resources.put(user.principal, 'preferences', user.principal.ownerId, { ...record.preferences, displayName: identity.displayName }, { expectedRevision: record.revision });
      const saved = await preferences(store, user.principal);
      setCookie(reply, sessionCookie, user.token, Math.max(0, Math.floor((Math.min(Date.parse(user.principal.expiresAt), identity.expiresAt) - now()) / 1000)), secure);
      return { identity: IdentitySchema.parse({ kind: 'user', displayName: saved.preferences.displayName || undefined, expiresAt: user.principal.expiresAt, signInAvailable: true }), ...saved };
    } catch (error) { await store.revoke(user.principal); throw error; }
  });
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requireOrigin(request); if (!available) throw new StoreError(503, 'OIDC_UNAVAILABLE', 'Account sign-in is not configured. Guest lessons remain available.');
    const config = await discovery();
    const original = request.headers.authorization ? await requestPrincipal(request, store) : await store.authenticate((await store.createGuest()).token);
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    await store.resources.put<LoginState>(original, 'oidc-login', digest(state), { verifier, nonce, expiresAt: now() + 5 * 60000, original }, { expectedRevision: -1 });
    const payload = Buffer.from(JSON.stringify({ state, ownerId: original.ownerId })).toString('base64url'); setCookie(reply, loginCookie, `${payload}.${sign(payload)}`, 300, secure);
    const url = new URL(config.authorization_endpoint); url.searchParams.set('response_type', 'code'); url.searchParams.set('client_id', env.OIDC_CLIENT_ID!); url.searchParams.set('redirect_uri', `${apiOrigin}/auth/callback`); url.searchParams.set('scope', 'openid profile email'); url.searchParams.set('state', state); url.searchParams.set('nonce', nonce); url.searchParams.set('code_challenge_method', 'S256'); url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    return { url: url.toString() };
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/auth/callback', async (request, reply) => {
    setCookie(reply, loginCookie, '', 0, secure);
    if (!available) throw new StoreError(503, 'OIDC_UNAVAILABLE', 'Account sign-in is not configured.');
    const binding = cookie(request, loginCookie), [payload, signature, extra] = binding?.split('.') ?? [];
    if (!payload || !signature || extra || !equal(sign(payload), signature) || !request.query.state || !request.query.code || request.query.code.length > 4000) throw new StoreError(400, 'INVALID_LOGIN_STATE', 'Sign-in expired or could not be verified. Start again.');
    let parsed: { state: string; ownerId: string }; try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new StoreError(400, 'INVALID_LOGIN_STATE', 'Sign-in could not be verified.'); }
    if (typeof parsed.state !== 'string' || typeof parsed.ownerId !== 'string' || !equal(parsed.state, request.query.state)) throw new StoreError(400, 'INVALID_LOGIN_STATE', 'Sign-in could not be verified.');
    const internalPrincipal = await store.principalForOwner(parsed.ownerId);
    const state = await store.locked(`login:${digest(parsed.state)}`, async () => {
      const record = await store.resources.get<LoginState>(internalPrincipal, 'oidc-login', digest(parsed.state));
      if (record.data.expiresAt <= now()) throw new StoreError(400, 'LOGIN_EXPIRED', 'Sign-in expired. Start again.');
      await store.resources.delete(internalPrincipal, 'oidc-login', record.id); return record.data;
    });
    const config = await discovery(), form = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.OIDC_CLIENT_ID!, code: request.query.code, redirect_uri: `${apiOrigin}/auth/callback`, code_verifier: state.verifier });
    if (env.OIDC_CLIENT_SECRET) form.set('client_secret', env.OIDC_CLIENT_SECRET);
    const response = await requestFetch(config.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new StoreError(400, 'OIDC_CODE_REJECTED', 'The sign-in code could not be verified. Start again.');
    const tokens = await response.json() as { id_token?: string }; if (!tokens.id_token || tokens.id_token.length > 20000) throw new StoreError(400, 'OIDC_TOKEN_INVALID', 'The sign-in token could not be verified.');
    let claims;
    try {
      const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(config.jwks_uri), { timeoutDuration: 7000 }), { issuer: env.OIDC_ISSUER, audience: env.OIDC_CLIENT_ID, algorithms: ['RS256', 'ES256'], maxTokenAge: '10m', requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'] });
      claims = verified.payload; if (claims.nonce !== state.nonce || claims.azp !== undefined && claims.azp !== env.OIDC_CLIENT_ID || Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== env.OIDC_CLIENT_ID) throw new Error('Invalid token binding');
    } catch { throw new StoreError(400, 'OIDC_TOKEN_INVALID', 'The sign-in token could not be verified.'); }
    const displayName = typeof claims.name === 'string' ? claims.name.slice(0, 80) : typeof claims.preferred_username === 'string' ? claims.preferred_username.slice(0, 80) : '';
    const user = await store.createUser({ issuer: env.OIDC_ISSUER!, subject: claims.sub!, displayName });
    if (state.original.kind === 'guest') { try { await options.closeOwner?.(state.original.ownerId); await store.claimGuest(state.original, user.principal); } catch (error) { await store.revoke(user.principal); throw error; } }
    const record = await preferences(store, user.principal); if (!record.preferences.displayName && displayName) await store.resources.put(user.principal, 'preferences', user.principal.ownerId, { ...record.preferences, displayName }, { expectedRevision: record.revision });
    setCookie(reply, sessionCookie, user.token, Math.max(0, Math.floor((Date.parse(user.principal.expiresAt) - now()) / 1000)), secure);
    return reply.redirect(`${origin}/dashboard`);
  });
  app.post('/auth/logout', async (request, reply) => {
    requireOrigin(request);
    if (request.headers.authorization) { try { const principal = await requestPrincipal(request, store); await store.revoke(principal); await options.closeOwner?.(principal.ownerId); } catch (error) { if (!(error instanceof StoreError && error.status === 401)) throw error; } }
    clearIdentityCookies(reply, env); return reply.status(204).send();
  });
}
