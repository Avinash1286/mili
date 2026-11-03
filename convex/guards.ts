import { ConvexError } from 'convex/values';
export function fail(code: string, status: number, message: string): never { throw new ConvexError({ code, status, message }); }
export async function service(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.subject !== 'tokai-service' || identity.issuer !== (process.env.TOKAI_SERVICE_ISSUER ?? 'http://localhost:4000')) fail('UNAUTHORIZED', 401, 'A service identity is required.');
}
export const byId = (ctx: any, table: string, id: string) => ctx.db.query(table).withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
export async function authorize(ctx: any, principal: any) {
  if (!principal || typeof principal.ownerId !== 'string' || principal.hash !== principal.ownerId || !Number.isFinite(Date.parse(principal.expiresAt)) || Date.parse(principal.expiresAt) <= Date.now()) fail('TOKEN_EXPIRED', 401, 'Your session expired. Sign in or start a new guest session.');
  const owner = await byId(ctx, 'owners', principal.ownerId);
  if (!owner || owner.deletedAt !== undefined || owner.expiresAt !== undefined && owner.expiresAt <= Date.now()) fail('UNAUTHORIZED', 401, 'A valid session is required.');
  if (!principal.internal) {
    const auth = await byId(ctx, 'authSessions', principal.authSessionId);
    if (!auth || auth.ownerId !== owner.id || auth.revokedAt !== undefined || auth.expiresAt <= Date.now()) fail('UNAUTHORIZED', 401, 'A valid session is required.');
  }
  return owner;
}
export async function activeOwner(ctx: any, ownerId: string) {
  const owner = await byId(ctx, 'owners', ownerId);
  if (!owner || owner.deletedAt !== undefined || owner.expiresAt !== undefined && owner.expiresAt <= Date.now()) fail('NOT_FOUND', 404, 'The owner is no longer available.');
  return owner;
}
export async function session(ctx: any, ownerId: string, id: string) {
  const item = await byId(ctx, 'sessions', id); if (!item || item.ownerId !== ownerId || item.deletedAt !== undefined) fail('NOT_FOUND', 404, 'Lesson not found.'); return item;
}
export async function resource(ctx: any, ownerId: string, kind: string, id: string) {
  const item = await ctx.db.query('resources').withIndex('by_key', (q: any) => q.eq('ownerId', ownerId).eq('kind', kind).eq('id', id)).unique();
  if (!item || item.deletedAt !== undefined) fail('NOT_FOUND', 404, 'The requested item is not available.');
  if (item.sessionId) await session(ctx, ownerId, item.sessionId); return item;
}
export function publicResource(item: any) { const { _id, _creationTime, deletedAt, ...result } = item; return result; }
export function principal(owner: any, auth?: any) { return { ownerId: owner.id, hash: owner.id, kind: owner.kind, authSessionId: auth?.id ?? '', expiresAt: new Date(auth?.expiresAt ?? owner.expiresAt ?? Date.now() + 7 * 86400000).toISOString(), ...(!auth ? { internal: true } : {}) }; }
export function bounded(value: unknown, maximum = 900000) { if (JSON.stringify(value).length > maximum) fail('RESOURCE_TOO_LARGE', 413, 'This saved item exceeds its size limit.'); }
