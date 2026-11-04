import { describe, expect, it } from 'vitest';
import { assertNativeAuthCapabilities, nativeAuthRequestAllowed } from '../../../convex/native_auth_policy.js';

describe('restricted native auth capability boundary', () => {
  it('allows password sessions and Convex token/JWKS discovery only', () => {
    for (const [method, path] of [['POST', 'sign-up/email'], ['POST', 'sign-in/email'], ['POST', 'sign-out'], ['GET', 'get-session'], ['GET', 'convex/token'], ['GET', 'convex/jwks'], ['GET', 'convex/.well-known/openid-configuration']]) {
      expect(nativeAuthRequestAllowed(new Request(`http://localhost/api/auth/${path}`, { method }))).toBe(true);
    }
    for (const path of ['sign-in/magic-link', 'magic-link/verify', 'sign-in/social', 'oauth2/callback/google', 'callback/google', 'callback/google/oauth-proxy', 'device/code', 'device/approve', 'device/token', 'convex/rotate-keys', '%73ign-in/email', 'sign-in/email/', 'new-unreviewed-route']) {
      for (const method of ['GET', 'POST']) expect(nativeAuthRequestAllowed(new Request(`http://localhost/api/auth/${path}`, { method }))).toBe(false);
    }
    expect(nativeAuthRequestAllowed(new Request('http://localhost/api/auth/sign-up/email', { method: 'GET' }))).toBe(false);
  });
  it('fails closed when configuration enables an unreviewed plugin, social provider or linking', () => {
    const allowed = { plugins: [{ id: 'convex' }], account: { accountLinking: { enabled: false } } };
    expect(() => assertNativeAuthCapabilities(allowed)).not.toThrow();
    for (const id of ['magic-link', 'oauth-proxy', 'device-authorization', 'generic-oauth']) expect(() => assertNativeAuthCapabilities({ ...allowed, plugins: [...allowed.plugins, { id }] })).toThrow(/restricted/);
    expect(() => assertNativeAuthCapabilities({ ...allowed, socialProviders: { google: {} } })).toThrow(/restricted/);
    expect(() => assertNativeAuthCapabilities({ ...allowed, account: { accountLinking: { enabled: true } } })).toThrow(/restricted/);
  });
});
