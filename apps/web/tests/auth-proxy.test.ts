import { expect, it } from 'vitest';
import { nativeAuthProxyRequest } from '../auth-proxy';

it('keeps native account cookies while stripping app and Vercel capabilities across the Convex boundary', async () => {
  const request = new Request('https://app.example.test/api/auth/sign-in/email', { method: 'POST', body: '{"test":true}', headers: {
    'Content-Type': 'application/json', Origin: 'https://app.example.test', 'x-vercel-protection-bypass': 'test-bypass-only', 'x-vercel-set-bypass-cookie': 'true', Authorization: 'Bearer app-session',
    Cookie: 'tokai_session=application-only; __vercel_protection_bypass=deployment-only; better-auth.session_token=native; __Secure-better-auth.session_data=secure-native; __Host-better-auth.convex_jwt=host-native; unrelated=nothing; evilbetter-auth.session_token=wrong-prefix',
  } });
  const forwarded = await nativeAuthProxyRequest(request);
  expect(forwarded.headers.get('cookie')).toBe('better-auth.session_token=native; __Secure-better-auth.session_data=secure-native; __Host-better-auth.convex_jwt=host-native');
  expect(forwarded.headers.has('authorization')).toBe(false); expect(forwarded.headers.has('x-vercel-protection-bypass')).toBe(false); expect(forwarded.headers.has('x-vercel-set-bypass-cookie')).toBe(false);
  expect(forwarded.headers.get('origin')).toBe('https://app.example.test'); expect(forwarded.headers.get('content-type')).toBe('application/json'); expect(await forwarded.text()).toBe('{"test":true}');
});
it('omits cookie entirely when a request has no native-library credentials', async () => {
  const forwarded = await nativeAuthProxyRequest(new Request('https://app.example.test/api/auth/get-session', { headers: { Cookie: 'tokai_session=app-only; __vercel_jwt=deployment-only' } }));
  expect(forwarded.headers.has('cookie')).toBe(false);
});
it('accepts a framework request facade without cloning private Request state and bounds its body', async () => {
  const request = new Request('https://app.example.test/api/auth/sign-up/email', { method: 'POST', body: '{"test":true}' });
  const facade = { url: request.url, method: request.method, headers: request.headers, body: request.body } as Request;
  expect(await (await nativeAuthProxyRequest(facade)).text()).toBe('{"test":true}');
  await expect(nativeAuthProxyRequest(new Request(request.url, { method: 'POST', body: 'x'.repeat(65537) }))).rejects.toThrow('64KiB');
});
