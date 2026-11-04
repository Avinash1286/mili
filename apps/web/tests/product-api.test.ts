import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LearnerPreferencesSchema } from '@milli/contracts';

const key = 'tokai.guest.v1';
const guest = { token: 'guest-token', expiresAt: new Date(Date.now() + 86400000).toISOString() };
const me = (kind: 'anonymous' | 'guest' | 'user') => ({ identity: { kind, signInAvailable: true }, preferences: LearnerPreferencesSchema.parse({}), revision: -1 });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let storage: Map<string, string>;
beforeEach(() => { vi.resetModules(); storage = new Map(); vi.stubGlobal('localStorage', { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browser ownership and credential boundaries', () => {
  it('inspects anonymous identity without creating a guest', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => json(me('anonymous'))); vi.stubGlobal('fetch', fetch);
    const { api } = await import('../src/lib/api');
    expect((await api.me()).identity.kind).toBe('anonymous');
    expect(fetch).toHaveBeenCalledTimes(1);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toMatch(/\/v1\/me$/); expect(calls[0]![1].credentials).toBe('include');
    expect(new Headers(calls[0]![1].headers).has('Authorization')).toBe(false);
  });
  it('uses cookie identity and clears a stale guest after account migration', async () => {
    storage.set(key, JSON.stringify(guest)); const calls: { url: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => { calls.push({ url, options }); return json(url.endsWith('/v1/me') ? me('user') : { sessions: [] }); });
    const { api } = await import('../src/lib/api'); await api.list();
    expect(storage.has(key)).toBe(false); expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.options?.headers).get('Authorization')).toBe('Bearer guest-token');
    expect(new Headers(calls[1]!.options?.headers).has('Authorization')).toBe(false);
    expect(calls[1]!.options?.credentials).toBe('include');
  });
  it('reuses an owned guest and never sends its bearer to a public share', async () => {
    storage.set(key, JSON.stringify(guest)); const calls: { url: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => { calls.push({ url, options }); return url.includes('/v1/shares/') ? json({ message: 'Expired link' }, 404) : json(url.endsWith('/v1/me') ? me('guest') : { sessions: [] }); });
    const { api } = await import('../src/lib/api'); await api.list(); await expect(api.publicShare('expired/token')).rejects.toThrow('Expired link');
    expect(new Headers(calls[1]!.options?.headers).get('Authorization')).toBe('Bearer guest-token');
    expect(calls[2]!.url).toMatch(/expired%2Ftoken$/); expect(calls[2]!.options?.credentials).toBe('omit');
    expect(new Headers(calls[2]!.options?.headers).has('Authorization')).toBe(false);
    expect(calls.some(call => call.url.includes('guest-sessions'))).toBe(false);
  });
  it('singleflights guest creation for concurrent first protected requests', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return json(url.endsWith('/v1/me') ? me('anonymous') : url.endsWith('/v1/guest-sessions') ? guest : { sessions: [] }); });
    const { api } = await import('../src/lib/api'); await Promise.all([api.list(), api.list()]);
    expect(calls.filter(url => url.endsWith('/v1/guest-sessions'))).toHaveLength(1); expect(storage.get(key)).toBe(JSON.stringify(guest));
  });
  it('does not reuse a revoked guest that identity inspection rejects', async () => {
    storage.set(key, JSON.stringify(guest)); const replacement = { ...guest, token: 'new-guest' }; const headers: Headers[] = [];
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => { headers.push(new Headers(options?.headers)); return json(url.endsWith('/v1/me') ? me('anonymous') : url.endsWith('/v1/guest-sessions') ? replacement : { sessions: [] }); });
    const { api } = await import('../src/lib/api'); await api.list();
    expect(headers.at(-1)?.get('Authorization')).toBe('Bearer new-guest');
  });
  it('does not let a slower anonymous inspection erase a concurrently created guest', async () => {
    let resolveInspection!: (response: Response) => void, inspected = false;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/v1/me') && !inspected) { inspected = true; return new Promise<Response>(resolve => { resolveInspection = resolve; }); }
      return json(url.endsWith('/v1/me') ? me('anonymous') : url.endsWith('/v1/guest-sessions') ? guest : { sessions: [] });
    });
    const { api } = await import('../src/lib/api'); const inspection = api.me(); await api.list();
    resolveInspection(json(me('anonymous'))); await inspection;
    expect(storage.get(key)).toBe(JSON.stringify(guest));
  });
  it('preserves revision conflicts and clears guest credentials only on authenticated 401', async () => {
    storage.set(key, JSON.stringify(guest)); let status = 409;
    vi.stubGlobal('fetch', async (url: string) => url.endsWith('/v1/me') ? json(me('guest')) : json({ message: 'Changed elsewhere', code: 'VERSION_CONFLICT' }, status));
    const { api, RequestError } = await import('../src/lib/api');
    await expect(api.notes('lesson', 'My retained draft', 4)).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(storage.has(key)).toBe(true); status = 401;
    await expect(api.notes('lesson', 'My retained draft', 4)).rejects.toBeInstanceOf(RequestError); expect(storage.has(key)).toBe(false);
  });
  it('bounds cached identity headers to two seconds and invalidates changed credentials', async () => {
    storage.set(key, JSON.stringify(guest)); const calls: string[] = []; const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return json(url.endsWith('/v1/me') ? me('guest') : { sessions: [] }); });
    const { api } = await import('../src/lib/api'); await api.list(); await api.list();
    expect(calls.filter(url => url.endsWith('/v1/me'))).toHaveLength(1);
    clock.mockReturnValue(start + 2001); await api.list(); expect(calls.filter(url => url.endsWith('/v1/me'))).toHaveLength(2);
    storage.set(key, JSON.stringify({ ...guest, token: 'another-guest' })); await api.list(); expect(calls.filter(url => url.endsWith('/v1/me'))).toHaveLength(3);
  });
  it('does not reuse identity headers across logout even inside the cache window', async () => {
    storage.set(key, JSON.stringify(guest)); let identity: 'guest' | 'anonymous' = 'guest'; const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); if (url.endsWith('/auth/logout')) { identity = 'anonymous'; return new Response(null, { status: 204 }); } return json(url.endsWith('/v1/me') ? me(identity) : url.endsWith('/v1/guest-sessions') ? { ...guest, token: 'after-logout' } : { sessions: [] }); });
    const { api } = await import('../src/lib/api'); await api.list(); await api.logout(); await api.list();
    expect(calls.filter(url => url.endsWith('/v1/me'))).toHaveLength(3); expect(storage.get(key)).toContain('after-logout');
  });
});
