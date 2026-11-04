import { makeFunctionReference } from 'convex/server';
import { v, ConvexError } from 'convex/values';
import { mutation, internalMutation, internalQuery, httpAction } from './_generated/server';
import { activeOwner, authorize, byId, fail, principal, resource, service, session } from './guards.js';
import { validateTransferContent } from '../packages/db/src/transfer-validation.js';
import { reserveUsage, settleUsage, updateStorageInventory } from './usage.js';
import { objectAuthority } from './storage.js';

const kind = v.union(v.literal('source'), v.literal('artifact'));
const operation = v.union(v.literal('upload'), v.literal('download'));
const hashBytes = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const ref = (name: string) => makeFunctionReference<any>(`transfers:${name}`);
async function descriptor(ctx: any, ticket: any) {
  const owner = await activeOwner(ctx, ticket.ownerId), auth = await byId(ctx, 'authSessions', ticket.authSessionId);
  if (!auth || auth.revokedAt !== undefined || auth.expiresAt <= Date.now() || auth.ownerId !== owner.id) fail('TRANSFER_EXPIRED', 401, 'This file transfer is no longer authorized.');
  const record = await resource(ctx, owner.id, ticket.kind, ticket.resourceId);
  if (record.revision !== ticket.resourceRevision) fail('TRANSFER_CHANGED', 409, 'This file changed. Request a new transfer.');
  if (ticket.operation === 'download' && record.data.fileExpiresAt && Date.parse(record.data.fileExpiresAt) <= Date.now()) fail('OBJECT_EXPIRED', 410, 'This saved file reached its retention limit.');
  if (ticket.kind === 'source') {
    if (ticket.operation === 'upload' && (record.data.status !== 'awaiting-upload' || Date.parse(record.createdAt) + 3600000 <= Date.now())) fail('UPLOAD_EXPIRED', 409, 'This upload is no longer available.');
    const key = `source/${record.id}`, attribution = await objectAuthority(ctx, principal(owner, auth), key);
    return { key, ownerId: owner.id, ownerExpiresAt: owner.expiresAt, sessionId: attribution.sessionId, retentionDays: attribution.retentionDays, size: record.data.bytes, contentType: record.data.mimeType, checksum: record.data.checksum, filename: record.data.filename };
  }
  if (ticket.operation !== 'download' || record.data.status !== 'ready') fail('ARTIFACT_NOT_READY', 409, 'This download is not ready.');
  const lesson = await session(ctx, owner.id, record.sessionId), file = await resource(ctx, owner.id, 'artifact-file', record.id);
  if (ticket.fileRevision !== undefined && ticket.fileRevision !== file.revision || record.data.kind === 'recap' && !lesson.snapshot.settings?.preferences.retainRecapAudio) fail('DOWNLOAD_REVOKED', 409, 'This download changed or its retention consent was withdrawn.');
  const attribution = await objectAuthority(ctx, principal(owner, auth), file.data.storageKey);
  return { key: file.data.storageKey, ownerId: owner.id, ownerExpiresAt: owner.expiresAt, sessionId: attribution.sessionId, retentionDays: attribution.retentionDays, contentType: file.data.contentType, filename: file.data.filename, fileRevision: file.revision };
}
export const issue = mutation({ args: { principal: v.any(), hash: v.string(), kind, resourceId: v.string(), operation }, handler: async (ctx, args) => {
  await service(ctx); const owner = await authorize(ctx, args.principal);
  if (args.principal.internal || !/^[a-f0-9]{64}$/.test(args.hash)) fail('INVALID_TRANSFER', 400, 'Invalid file transfer.');
  const record = await resource(ctx, owner.id, args.kind, args.resourceId);
  const value = { hash: args.hash, ownerId: owner.id, authSessionId: args.principal.authSessionId, kind: args.kind, resourceId: args.resourceId, resourceRevision: record.revision, operation: args.operation, expiresAt: Math.min(Date.now() + 300000, Date.parse(args.principal.expiresAt)) };
  const file = await descriptor(ctx, value);
  for (const old of await ctx.db.query('transferTickets').withIndex('by_resource', q => q.eq('ownerId', owner.id).eq('kind', args.kind).eq('resourceId', args.resourceId)).take(20)) await ctx.db.delete(old._id);
  await ctx.db.insert('transferTickets', { ...value, ...('fileRevision' in file ? { fileRevision: file.fileRevision } : {}) });
  for (const old of await ctx.db.query('transferTickets').withIndex('by_expiry', q => q.lte('expiresAt', Date.now())).take(20)) await ctx.db.delete(old._id);
  return { expiresAt: value.expiresAt, contentType: file.contentType };
} });
async function ticketByHash(ctx: any, hash: string, consumed: boolean) {
  const item = await ctx.db.query('transferTickets').withIndex('by_hash', (q: any) => q.eq('hash', hash)).unique();
  if (!item || item.expiresAt <= Date.now() || (item.consumedAt !== undefined) !== consumed) fail('TRANSFER_EXPIRED', 401, 'Request a fresh file transfer.');
  return item;
}
export const consume = internalMutation({ args: { hash: v.string(), operation }, handler: async (ctx, args) => {
  const ticket = await ticketByHash(ctx, args.hash, false); if (ticket.operation !== args.operation) fail('INVALID_TRANSFER', 403, 'This token does not authorize that operation.');
  const file = await descriptor(ctx, ticket), usageReservationId = `transfer:${args.hash}`;
  const stored = args.operation === 'download' ? await ctx.db.query('files').withIndex('by_key', q => q.eq('key', file.key)).unique() : undefined;
  if (args.operation === 'download' && (!stored || stored.size > 20 * 1024 * 1024 || stored.ownerId && stored.ownerId !== file.ownerId)) fail('OBJECT_MISSING', 404, 'Saved file is not available.');
  if (stored?.expiresAt !== undefined && stored.expiresAt <= Date.now()) fail('OBJECT_EXPIRED', 410, 'This saved file reached its retention limit.');
  await reserveUsage(ctx, { id: usageReservationId, ownerId: ticket.ownerId, kind: args.operation === 'upload' ? 'storage' : 'egress', units: stored?.size ?? file.size!, sessionId: file.sessionId, traceId: file.key, ...(args.operation === 'upload' ? { retentionDays: file.retentionDays } : {}) });
  await ctx.db.patch(ticket._id, { consumedAt: Date.now(), usageReservationId });
  return { ...file, ...(stored ? { storageId: stored.storageId, size: stored.size } : {}) };
} });
export const validate = internalQuery({ args: { hash: v.string() }, handler: async (ctx, args) => descriptor(ctx, await ticketByHash(ctx, args.hash, true)) });
export const finish = internalMutation({ args: { hash: v.string(), storageId: v.id('_storage') }, handler: async (ctx, args) => {
  const ticket = await ticketByHash(ctx, args.hash, true); if (ticket.operation !== 'upload') fail('INVALID_TRANSFER', 403, 'Invalid upload token.');
  const file = await descriptor(ctx, ticket), stored = await ctx.db.system.get(args.storageId);
  const digest = stored && (/^[a-f0-9]{64}$/i.test(stored.sha256) ? stored.sha256.toLowerCase() : [...Uint8Array.from(atob(stored.sha256), char => char.charCodeAt(0))].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  if (!stored || !digest || stored.size !== file.size || stored.contentType !== file.contentType || digest !== file.checksum) fail('INVALID_UPLOAD', 400, 'The uploaded bytes did not match the request.');
  if (!ticket.usageReservationId) fail('UPLOAD_EXPIRED', 409, 'This upload admission is missing.');
  const lease = await ctx.db.query('usageReservations').withIndex('by_external_id', q => q.eq('id', ticket.usageReservationId!)).unique();
  if (!lease || lease.ownerId !== ticket.ownerId || lease.state !== 'running' || lease.expiresAt <= Date.now() || lease.units < stored.size) fail('UPLOAD_EXPIRED', 409, 'This upload admission expired.');
  const previous = await ctx.db.query('files').withIndex('by_key', q => q.eq('key', file.key)).unique(), deadlines = [lease.retentionUntil, file.ownerExpiresAt].filter((value): value is number => typeof value === 'number');
  const value = { key: file.key, storageId: args.storageId, size: stored.size, contentType: file.contentType, checksum: digest, ownerId: ticket.ownerId, ...(file.sessionId ? { sessionId: file.sessionId } : {}), ...(deadlines.length ? { expiresAt: Math.min(...deadlines) } : {}) };
  if (previous) { await ctx.db.replace(previous._id, value); if (previous.storageId !== args.storageId) await ctx.storage.delete(previous.storageId); } else await ctx.db.insert('files', value);
  if (previous?.ownerId && previous.ownerId !== ticket.ownerId) await updateStorageInventory(ctx, previous.ownerId, -previous.size, -1);
  await updateStorageInventory(ctx, ticket.ownerId, stored.size - (previous && previous.ownerId === ticket.ownerId ? previous.size : 0), previous && previous.ownerId === ticket.ownerId ? 0 : 1);
  await settleUsage(ctx, { id: ticket.usageReservationId, ownerId: ticket.ownerId, success: true, usedUnits: stored.size, observation: { storageBytesWritten: stored.size } });
} });
export const downloadComplete = internalMutation({ args: { hash: v.string(), storageId: v.id('_storage') }, handler: async (ctx, args) => {
  const ticket = await ticketByHash(ctx, args.hash, true), file = await descriptor(ctx, ticket), stored = await ctx.db.query('files').withIndex('by_key', q => q.eq('key', file.key)).unique();
  if (!stored || stored.storageId !== args.storageId || stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) fail('DOWNLOAD_CHANGED', 409, 'This file changed while downloading.');
  if (!ticket.usageReservationId) fail('TRANSFER_EXPIRED', 409, 'This transfer admission expired.');
  await settleUsage(ctx, { id: ticket.usageReservationId, ownerId: ticket.ownerId, success: true, usedUnits: stored.size, observation: { egressBytesPrepared: stored.size } }); return null;
} });
export const cancel = internalMutation({ args: { hash: v.string() }, handler: async (ctx, args) => {
  const ticket = await ctx.db.query('transferTickets').withIndex('by_hash', q => q.eq('hash', args.hash)).unique();
  if (ticket?.usageReservationId) await settleUsage(ctx, { id: ticket.usageReservationId, ownerId: ticket.ownerId, success: false }); return null;
} });
export const discard = internalMutation({ args: { storageId: v.id('_storage') }, handler: async (ctx, args) => {
  if (!await ctx.db.query('files').withIndex('by_storage', q => q.eq('storageId', args.storageId)).first()) await ctx.storage.delete(args.storageId);
} });
function cors(request: Request): Record<string, string> {
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  if (request.headers.get('origin') !== origin) fail('INVALID_ORIGIN', 403, 'This transfer origin is not allowed.');
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Expose-Headers': 'Content-Disposition,Content-Type', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
}
export const content = httpAction(async (ctx, request) => {
  let headers: Record<string, string> = {}, admittedHash: string | undefined;
  try {
    headers = cors(request); if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const token = request.headers.get('authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
    if (!token) fail('INVALID_TRANSFER', 401, 'A file transfer token is required.');
    const hash = await hashBytes(new TextEncoder().encode(token)), uploading = request.method === 'PUT';
    const file = await ctx.runMutation(ref('consume'), { hash, operation: uploading ? 'upload' : 'download' });
    admittedHash = hash;
    if (!uploading) {
      const blob = await ctx.storage.get(file.storageId); if (!blob) fail('OBJECT_MISSING', 404, 'Saved file is not available.');
      await ctx.runMutation(ref('downloadComplete'), { hash, storageId: file.storageId });
      return new Response(blob, { headers: { ...headers, 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${String(file.filename ?? 'tokai-download').replace(/[^a-zA-Z0-9._-]/g, '_')}"` } });
    }
    if (!request.body || request.headers.get('content-type')?.split(';')[0] !== file.contentType || file.size > 10 * 1024 * 1024) fail('INVALID_UPLOAD', 400, 'Invalid upload body.');
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > file.size || size > 10 * 1024 * 1024) { await reader.cancel(); fail('OBJECT_TOO_LARGE', 413, 'This upload exceeds its declared size.'); } chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { validateTransferContent(bytes, file.contentType, file.size); } catch { fail('INVALID_UPLOAD', 400, 'The uploaded file does not match its declared format or size.'); }
    if (await hashBytes(bytes) !== file.checksum) fail('CHECKSUM_MISMATCH', 400, 'The file checksum did not match.');
    const storageId = await ctx.storage.store(new Blob([bytes], { type: file.contentType }));
    try { await ctx.runMutation(ref('finish'), { hash, storageId }); }
    catch (error) { await ctx.runMutation(ref('discard'), { storageId }); throw error; }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (admittedHash) await ctx.runMutation(ref('cancel'), { hash: admittedHash }).catch(() => undefined);
    const data = error instanceof ConvexError && typeof error.data === 'object' && error.data !== null ? error.data as { status?: number; code?: string; message?: string } : undefined;
    return Response.json({ error: { code: data?.code ?? 'TRANSFER_FAILED', message: data?.message ?? 'This private transfer could not finish. Request a new transfer.' } }, { status: data?.status ?? 503, headers });
  }
});
