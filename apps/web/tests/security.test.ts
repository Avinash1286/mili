import { expect, it } from 'vitest';
import { securityHeaders } from '../security';
import { convexPublicServices } from '../public-services';

it('allows the same local production Convex transfer origins as the auth proxy', () => {
  const env = { NODE_ENV: 'production' }, services = convexPublicServices(env);
  const csp = securityHeaders(env).find(header => header.key === 'Content-Security-Policy')!.value;
  expect(csp).toContain(services.convexUrl); expect(csp).toContain(services.convexSiteUrl); expect(csp).toContain('http://localhost:4000');
  expect(csp).not.toContain("'unsafe-eval'"); expect(csp).toContain("frame-ancestors 'none'");
});
it('requires explicit HTTPS cloud URLs on Vercel and excludes loopback fallbacks', () => {
  expect(() => securityHeaders({ VERCEL: '1', NODE_ENV: 'production' })).toThrow('explicit public Convex');
  const csp = securityHeaders({ VERCEL: '1', NODE_ENV: 'production', NEXT_PUBLIC_API_URL: '/', NEXT_PUBLIC_CONVEX_URL: 'https://example.convex.cloud', NEXT_PUBLIC_CONVEX_SITE_URL: 'https://example.convex.site' })[0]!.value;
  expect(csp).toContain('https://example.convex.site'); expect(csp).toContain('wss://example.convex.cloud'); expect(csp).not.toContain('localhost'); expect(csp).not.toContain('127.0.0.1');
});
