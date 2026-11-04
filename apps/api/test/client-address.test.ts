import { expect, it } from 'vitest';
import { clientAddress } from '../src/client-address';

it('uses only Vercel-overwritten single IP values while other runtimes ignore forwarded headers', () => {
  const request = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.8' } };
  expect(clientAddress(request, true)).toBe('203.0.113.8'); expect(clientAddress(request, false)).toBe('127.0.0.1');
  expect(clientAddress({ ...request, headers: { 'x-forwarded-for': '2001:db8::8' } }, true)).toBe('2001:db8::8');
  for (const value of ['203.0.113.8, 192.0.2.1', 'untrusted-user-label', ['203.0.113.8'], undefined]) expect(clientAddress({ ...request, headers: { 'x-forwarded-for': value } }, true)).toBe('127.0.0.1');
});
