import { makeFunctionReference } from 'convex/server';
import { mutation, query, internalQuery, action } from './_generated/server';
import { v } from 'convex/values';
import { fail, service } from './guards.js';
const maximumBytes = 20 * 1024 * 1024;
const checkKey = (key: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,499}$/.test(key) || key.split('/').some(part => !part || part === '..' || part === '.')) fail('INVALID_OBJECT_KEY', 400, 'Invalid storage object.'); };
const lookup = (ctx: any, key: string) => ctx.db.query('files').withIndex('by_key', (q: any) => q.eq('key', key)).unique();
export const upload = mutation({ args: {}, handler: async ctx => { await service(ctx); return ctx.storage.generateUploadUrl(); } });
export const finish = mutation({ args: { key: v.string(), storageId: v.id('_storage'), size: v.number(), contentType: v.string(), checksum: v.optional(v.string()) }, handler: async (ctx, args) => {
  await service(ctx); checkKey(args.key);
  const stored = await ctx.db.system.get(args.storageId);
  if (!stored || stored.size !== args.size || stored.size > maximumBytes || stored.size < 1 || stored.contentType !== args.contentType) { if (stored) await ctx.storage.delete(args.storageId); fail('INVALID_UPLOAD', 400, 'The uploaded file did not match its metadata.'); }
  // _storage currently returns base64; older metadata API versions documented hex.
  const digest = /^[a-f0-9]{64}$/i.test(stored.sha256) ? stored.sha256.toLowerCase() : [...Uint8Array.from(atob(stored.sha256), char => char.charCodeAt(0))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (args.checksum && digest !== args.checksum.toLowerCase()) fail('CHECKSUM_MISMATCH', 400, 'The uploaded file checksum did not match.');
  const old = await lookup(ctx, args.key);
  if (old) { await ctx.db.replace(old._id, args); if (old.storageId !== args.storageId) await ctx.storage.delete(old.storageId); }
  else await ctx.db.insert('files', args);
  return { size: stored.size, contentType: args.contentType, checksum: args.checksum ?? null };
} });
export const head = query({ args: { key: v.string() }, handler: async (ctx, args) => { await service(ctx); checkKey(args.key); const item = await lookup(ctx, args.key); if (!item) fail('OBJECT_MISSING', 404, 'Saved file is not available.'); return { size: item.size, contentType: item.contentType, checksum: item.checksum ?? null }; } });
export const resolve = internalQuery({ args: { key: v.string() }, handler: async (ctx, args) => { checkKey(args.key); const item = await lookup(ctx, args.key); if (!item) fail('OBJECT_MISSING', 404, 'Saved file is not available.'); return item; } });
export const get = action({ args: { key: v.string(), maxBytes: v.number() }, handler: async (ctx, args): Promise<{ body: ArrayBuffer; metadata: { size: number; contentType: string; checksum: string | null } }> => {
  await service(ctx); checkKey(args.key);
  const item = await ctx.runQuery(makeFunctionReference<'query'>('storage:resolve'), { key: args.key });
  if (item.size > Math.min(maximumBytes, args.maxBytes)) fail('OBJECT_TOO_LARGE', 413, 'This file exceeds the download limit.');
  const blob = await ctx.storage.get(item.storageId); if (!blob) fail('OBJECT_MISSING', 404, 'Saved file is not available.');
  return { body: await blob.arrayBuffer(), metadata: { size: item.size, contentType: item.contentType, checksum: item.checksum ?? null } };
} });
export const remove = mutation({ args: { key: v.string() }, handler: async (ctx, args) => { await service(ctx); checkKey(args.key); const item = await lookup(ctx, args.key); if (item) { await ctx.storage.delete(item.storageId); await ctx.db.delete(item._id); } return null; } });
/** A failed finish may have committed before its HTTP response was lost. Never delete an attached file. */
export const discard = mutation({ args: { storageId: v.id('_storage') }, handler: async (ctx, args) => { await service(ctx); const attached = await ctx.db.query('files').withIndex('by_storage', q => q.eq('storageId', args.storageId)).first(); if (!attached) await ctx.storage.delete(args.storageId); return null; } });
