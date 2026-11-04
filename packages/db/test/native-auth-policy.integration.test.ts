import { describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

describe.skipIf(process.env.TOKAI_TEST_CONVEX !== '1')('actual native auth restricted endpoints', () => {
  it('rejects every disabled optional flow while retaining session and public JWT discovery routes', async () => {
    loadEnvFile(fileURLToPath(new URL('../../../.env.local', import.meta.url)));
    const base = process.env.CONVEX_SITE_URL;
    if (!base) throw new Error('CONVEX_SITE_URL is required for native auth verification.');
    const request = (path: string, method = 'GET') => fetch(`${base}/api/auth/${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(10000), ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: '{}' } : {}) });
    for (const [path, method] of [['sign-in/magic-link', 'POST'], ['magic-link/verify?token=disabled', 'GET'], ['sign-in/social', 'POST'], ['oauth2/callback/google', 'GET'], ['callback/google', 'GET'], ['callback/google/oauth-proxy', 'GET'], ['device/code', 'POST'], ['device/approve', 'POST'], ['device/token', 'POST'], ['convex/rotate-keys', 'POST'], ['new-unreviewed-route', 'GET']]) {
      const response = await request(path!, method!); expect(response.status, `${method} ${path}`).toBe(404); expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await request('get-session')).status).toBe(200);
    const keys = await request('convex/jwks'); expect(keys.status).toBe(200); expect((await keys.json() as any).keys.length).toBeGreaterThan(0);
    expect((await request('convex/.well-known/openid-configuration')).status).toBe(200);
    expect((await request('convex/token')).status).toBe(401);
    expect((await request('sign-in/email', 'POST')).status).toBe(400);
  }, 30000);
});
