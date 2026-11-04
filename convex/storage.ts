import { makeFunctionReference } from 'convex/server';
import { mutation, query, internalMutation, action } from './_generated/server';
import { v } from 'convex/values';
import { authorize, fail, resource, service, session } from './guards.js';
import { reserveUsage, settleUsage, updateStorageInventory } from './usage.js';
const maximumBytes = 20 * 1024 * 1024;
const checkKey = (key: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,499}$/.test(key) || key.split('/').some(part => !part || part === '..' || part === '.')) fail('INVALID_OBJECT_KEY', 400, 'Invalid storage object.'); };
const lookup = (ctx: any, key: string) => ctx.db.query('files').withIndex('by_key', (q: any) => q.eq('key', key)).unique();
const receipt = (ctx: any, id: string) => ctx.db.query('usageReservations').withIndex('by_external_id', (q: any) => q.eq('id', id)).unique();
/** Derive attribution from an owned durable parent, never caller-supplied owner/session metadata. */
export async function objectAuthority(ctx: any, principal: any, key: string) {
  checkKey(key); const owner = await authorize(ctx, principal), [kind, id] = key.split('/');
  if (!['source', 'artifact'].includes(kind) || !id) fail('INVALID_OBJECT_KEY', 400, 'Files require an owned source or artifact.');
  const parent = await resource(ctx, owner.id, kind, id);
  const lesson = parent.sessionId ? await session(ctx, owner.id, parent.sessionId) : undefined;
  const preferences = lesson?.snapshot?.settings?.preferences ?? (await ctx.db.query('resources').withIndex('by_key', (q: any) => q.eq('ownerId', owner.id).eq('kind', 'preferences').eq('id', owner.id)).unique())?.data;
  const retentionDays = Number.isSafeInteger(preferences?.retentionDays) ? preferences.retentionDays : 30;
  return { owner, parent, sessionId: parent.sessionId as string | undefined, retentionDays };
}
function available(item: any, ownerId?: string) { if (!item || ownerId && item.ownerId && item.ownerId !== ownerId) fail('OBJECT_MISSING', 404, 'Saved file is not available.'); if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) fail('OBJECT_EXPIRED', 410, 'This saved file reached its retention limit.'); return item; }
export const upload = mutation({ args: { principal: v.any(), key: v.string(), size: v.number(), reservationId: v.string() }, handler: async (ctx, args) => {
  await service(ctx); const authority = await objectAuthority(ctx, args.principal, args.key);
  if (!Number.isSafeInteger(args.size) || args.size < 1 || args.size > maximumBytes) fail('OBJECT_TOO_LARGE', 413, 'This file exceeds the upload limit.');
  await reserveUsage(ctx, { ownerId: authority.owner.id, id: args.reservationId, kind: 'storage', units: args.size, sessionId: authority.sessionId, traceId: args.key, retentionDays: authority.retentionDays });
  return { uploadUrl: await ctx.storage.generateUploadUrl(), reservationId: args.reservationId };
} });
export const finish = mutation({ args: { principal: v.any(), reservationId: v.string(), key: v.string(), storageId: v.id('_storage'), size: v.number(), contentType: v.string(), checksum: v.optional(v.string()) }, handler: async (ctx, args) => {
  await service(ctx); const authority = await objectAuthority(ctx, args.principal, args.key), lease = await receipt(ctx, args.reservationId);
  if (!lease || lease.ownerId !== authority.owner.id || lease.kind !== 'storage' || lease.traceId !== args.key || lease.units < args.size || lease.state !== 'running' || lease.expiresAt <= Date.now()) fail('UPLOAD_EXPIRED', 409, 'This upload admission expired.');
  const stored = await ctx.db.system.get(args.storageId);
  if (!stored || stored.size !== args.size || stored.size > maximumBytes || stored.size < 1 || stored.contentType !== args.contentType) fail('INVALID_UPLOAD', 400, 'The uploaded file did not match its metadata.');
  const digest = /^[a-f0-9]{64}$/i.test(stored.sha256) ? stored.sha256.toLowerCase() : [...Uint8Array.from(atob(stored.sha256), char => char.charCodeAt(0))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (args.checksum && digest !== args.checksum.toLowerCase()) fail('CHECKSUM_MISMATCH', 400, 'The uploaded file checksum did not match.');
  const old = await lookup(ctx, args.key), deadlines = [lease.retentionUntil, authority.owner.expiresAt].filter((value): value is number => typeof value === 'number');
  const value = { key: args.key, storageId: args.storageId, size: args.size, contentType: args.contentType, checksum: args.checksum, ownerId: authority.owner.id, ...(authority.sessionId ? { sessionId: authority.sessionId } : {}), ...(deadlines.length ? { expiresAt: Math.min(...deadlines) } : {}) };
  if (old) { await ctx.db.replace(old._id, value); if (old.storageId !== args.storageId) await ctx.storage.delete(old.storageId); }
  else await ctx.db.insert('files', value);
  if (old?.ownerId && old.ownerId !== authority.owner.id) await updateStorageInventory(ctx, old.ownerId, -old.size, -1);
  await updateStorageInventory(ctx, authority.owner.id, args.size - (old?.ownerId === authority.owner.id ? old.size : 0), old?.ownerId === authority.owner.id ? 0 : 1);
  await settleUsage(ctx, { id: args.reservationId, ownerId: authority.owner.id, success: true, usedUnits: stored.size, observation: { storageBytesWritten: stored.size } });
  return { size: stored.size, contentType: args.contentType, checksum: args.checksum ?? null, ...(value.expiresAt === undefined ? {} : { expiresAt: new Date(value.expiresAt).toISOString() }) };
} });
export const head = query({ args: { key: v.string() }, handler: async (ctx, args) => { await service(ctx); checkKey(args.key); const item = available(await lookup(ctx, args.key)); return { size: item.size, contentType: item.contentType, checksum: item.checksum ?? null, ...(item.expiresAt === undefined ? {} : { expiresAt: new Date(item.expiresAt).toISOString() }) }; } });
export const readAdmission = internalMutation({ args: { principal: v.any(), key: v.string(), maxBytes: v.number(), reservationId: v.string() }, handler: async (ctx, args) => {
  const authority = await objectAuthority(ctx, args.principal, args.key), item = available(await lookup(ctx, args.key), authority.owner.id);
  if (item.size > Math.min(maximumBytes, args.maxBytes)) fail('OBJECT_TOO_LARGE', 413, 'This file exceeds the download limit.');
  await reserveUsage(ctx, { ownerId: authority.owner.id, id: args.reservationId, kind: 'egress', units: item.size, sessionId: authority.sessionId, traceId: args.key }); return item;
} });
export const readComplete = internalMutation({ args: { principal: v.any(), key: v.string(), storageId: v.id('_storage'), reservationId: v.string() }, handler: async (ctx, args) => {
  const authority = await objectAuthority(ctx, args.principal, args.key), item = available(await lookup(ctx, args.key), authority.owner.id);
  if (item.storageId !== args.storageId) fail('DOWNLOAD_CHANGED', 409, 'This file changed while downloading.');
  await settleUsage(ctx, { id: args.reservationId, ownerId: authority.owner.id, success: true, usedUnits: item.size, observation: { egressBytesPrepared: item.size } }); return null;
} });
export const cancel = mutation({ args: { reservationId: v.string(), ownerId: v.string() }, handler: async (ctx, args) => { await service(ctx); await settleUsage(ctx, { id: args.reservationId, ownerId: args.ownerId, success: false }); return null; } });
export const cancelInternal = internalMutation({ args: { reservationId: v.string(), ownerId: v.string() }, handler: async (ctx, args) => { await settleUsage(ctx, { id: args.reservationId, ownerId: args.ownerId, success: false }); return null; } });
export const get = action({ args: { principal: v.any(), key: v.string(), maxBytes: v.number() }, handler: async (ctx, args): Promise<{ body: ArrayBuffer; metadata: { size: number; contentType: string; checksum: string | null } }> => {
  await service(ctx); const reservationId = crypto.randomUUID();
  const item = await ctx.runMutation(makeFunctionReference<'mutation'>('storage:readAdmission'), { ...args, reservationId });
  try {
    const blob = await ctx.storage.get(item.storageId); if (!blob) fail('OBJECT_MISSING', 404, 'Saved file is not available.');
    const body = await blob.arrayBuffer();
    await ctx.runMutation(makeFunctionReference<'mutation'>('storage:readComplete'), { principal: args.principal, key: args.key, storageId: item.storageId, reservationId });
    return { body, metadata: { size: item.size, contentType: item.contentType, checksum: item.checksum ?? null } };
  } catch (error) { await ctx.runMutation(makeFunctionReference<'mutation'>('storage:cancelInternal'), { reservationId, ownerId: args.principal.ownerId }); throw error; }
} });
export const remove = mutation({ args: { key: v.string() }, handler: async (ctx, args) => { await service(ctx); checkKey(args.key); const item = await lookup(ctx, args.key); if (item) { await ctx.storage.delete(item.storageId); await ctx.db.delete(item._id); if (item.ownerId) await updateStorageInventory(ctx, item.ownerId, -item.size, -1); } return null; } });
/** A failed finish may have committed before its HTTP response was lost. Never delete an attached file. */
export const discard = mutation({ args: { storageId: v.id('_storage') }, handler: async (ctx, args) => { await service(ctx); const attached = await ctx.db.query('files').withIndex('by_storage', q => q.eq('storageId', args.storageId)).first(); if (!attached) await ctx.storage.delete(args.storageId); return null; } });
