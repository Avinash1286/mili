import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { generateOpenApi, type DocumentedRoute } from '../src/openapi.js';

test('generated HTTP contract covers actual routes and preserves authentication and binary boundaries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tokai-openapi-')), routes: DocumentedRoute[] = [];
  assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('tokai-openapi-'));
  let verified = false;
  const app = await createApp({ env: {}, dataDir: directory, rateLimit: false, routeObserver: route => routes.push(route), identity: { nativeIdentity: { verify: async () => { verified = true; throw new Error('Invalid input must not reach identity verification.'); }, active: async () => false, deleteAccount: async () => {} } } });
  try {
    await app.ready(); const document = generateOpenApi(routes);
    const message = document.paths['/v1/sessions/{id}/messages']!.post as any;
    assert.deepEqual(message.security, [{ guestBearer: [] }, { accountCookie: [] }]);
    assert.equal(message.requestBody.content['application/json'].schema.$ref, '#/components/schemas/SendMessageSchema');
    assert.deepEqual((document.paths['/internal/jobs/execute']!.post as any).security, [{ jobSecret: [] }]);
    assert.deepEqual((document.paths['/v1/shares/{token}']!.get as any).security, []);
    assert.ok((document.paths['/v1/voice']!.get as any).responses['101']);
    assert.equal((document.paths['/v1/sources/{id}/content']!.put as any)['x-body-limit-bytes'], 10 * 1024 * 1024);
    assert.equal((document.components.schemas.SendMessageSchema as any).properties.text.maxLength, 2000);
    const invalid = await app.inject({ method: 'POST', url: '/v1/guest-sessions' });
    const token = invalid.json().token as string;
    const bad = await app.inject({ method: 'POST', url: '/v1/lessons', headers: { authorization: `Bearer ${token}` }, payload: { topic: 'x' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().retryable, false);
    assert.equal(typeof bad.json().requestId, 'string');
    const malformedLogin = await app.inject({ method: 'POST', url: '/auth/native-session', headers: { origin: 'http://localhost:3000' }, payload: { token: 'short' } });
    assert.equal(malformedLogin.statusCode, 400); assert.equal(malformedLogin.json().code, 'INVALID_REQUEST'); assert.equal(verified, false);
    assert.throws(() => generateOpenApi([...routes, { method: 'POST', url: '/v1/undocumented' }]), /no OpenAPI definition/);
    assert.throws(() => generateOpenApi(routes.filter(route => route.url !== '/v1/lessons')), /not registered/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);
