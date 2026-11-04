import { createHash, randomBytes } from 'node:crypto';
import { StoreError, type Principal } from './types.js';
import { ServiceTransport, type ConvexTransport } from './transport.js';
export type ObjectMetadata = { size: number; contentType: string; checksum?: string; etag?: string };
export type PrivateTransfer = { url: string; headers: Record<string, string>; expiresAt: string };
export interface ObjectStore {
  health(): Promise<boolean>;
  put(key: string, body: Uint8Array, contentType: string, options?: { checksum?: string; signal?: AbortSignal }): Promise<ObjectMetadata>;
  get(key: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ body: Buffer; metadata: ObjectMetadata }>;
  head(key: string): Promise<ObjectMetadata>;
  delete(key: string): Promise<void>;
  close(): void;
  createTransfer?(principal: Principal, input: { kind: 'source' | 'artifact'; id: string; operation: 'upload' | 'download' }): Promise<PrivateTransfer>;
}
/** Private files: only the API service can resolve a key or retrieve bytes. No getUrl leaves this adapter. */
export class NativeObjectStore implements ObjectStore {
  constructor(private readonly transport: ConvexTransport, private readonly backendUrl: string, private readonly maxBytes = 20 * 1024 * 1024, private readonly siteUrl?: string) {}
  async createTransfer(principal: Principal, input: { kind: 'source' | 'artifact'; id: string; operation: 'upload' | 'download' }): Promise<PrivateTransfer> {
    const url = new URL(this.siteUrl ?? this.backendUrl);
    if (!this.siteUrl) {
      if (url.hostname.endsWith('.convex.cloud')) url.hostname = url.hostname.replace(/\.convex\.cloud$/, '.convex.site');
      else if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.port) url.port = String(Number(url.port) + 1);
      else throw new StoreError(503, 'TRANSFER_UNAVAILABLE', 'CONVEX_SITE_URL is required for private transfers.');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new StoreError(503, 'TRANSFER_UNAVAILABLE', 'Private transfers require HTTPS.');
    url.pathname = '/private-transfer'; url.search = ''; url.hash = '';
    const token = randomBytes(32).toString('base64url');
    const result = await this.transport.call<{ expiresAt: number; contentType: string }>('mutation', 'transfers:issue', { principal, hash: createHash('sha256').update(token).digest('hex'), kind: input.kind, resourceId: input.id, operation: input.operation });
    return { url: url.toString(), headers: { Authorization: `Bearer ${token}`, ...(input.operation === 'upload' ? { 'Content-Type': result.contentType } : {}) }, expiresAt: new Date(result.expiresAt).toISOString() };
  }
  async health() { try { await this.transport.call('query', 'store:read', { operation: 'health', input: {} }); return true; } catch { return false; } }
  async put(key: string, body: Uint8Array, contentType: string, options: { checksum?: string; signal?: AbortSignal } = {}) {
    if (!body.byteLength || body.byteLength > this.maxBytes) throw new StoreError(413, 'OBJECT_TOO_LARGE', 'This file exceeds the upload limit.');
    const actual = createHash('sha256').update(body).digest('hex'); if (options.checksum && options.checksum !== actual) throw new StoreError(400, 'CHECKSUM_MISMATCH', 'The file checksum did not match.');
    const uploadUrl = await this.transport.call<string>('mutation', 'storage:upload', {});
    if (new URL(uploadUrl).origin !== new URL(this.backendUrl).origin) throw new StoreError(503, 'INVALID_STORAGE_ORIGIN', 'The storage backend returned an unexpected upload address.');
    const response = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': contentType }, body: Buffer.from(body), signal: options.signal ?? AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new StoreError(503, 'UPLOAD_FAILED', 'The file could not be saved.');
    const { storageId } = await response.json() as { storageId: string };
    try { return await this.transport.call<ObjectMetadata>('mutation', 'storage:finish', { key, storageId, size: body.byteLength, contentType, checksum: actual }); }
    catch (error) { await this.transport.call('mutation', 'storage:discard', { storageId }).catch(() => undefined); throw error; }
  }
  async head(key: string) { return this.transport.call<ObjectMetadata>('query', 'storage:head', { key }); }
  async get(key: string, options: { maxBytes?: number; signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) throw new StoreError(409, 'DOWNLOAD_CANCELLED', 'The download was cancelled.');
    const result = await this.transport.call<{ body: ArrayBuffer; metadata: ObjectMetadata }>('action', 'storage:get', { key, maxBytes: Math.min(this.maxBytes, options.maxBytes ?? this.maxBytes) });
    if (options.signal?.aborted) throw new StoreError(409, 'DOWNLOAD_CANCELLED', 'The download was cancelled.');
    return { body: Buffer.from(result.body), metadata: result.metadata };
  }
  async delete(key: string) { await this.transport.call('mutation', 'storage:remove', { key }); }
  close() {}
  static fromEnv(env: Record<string, string | undefined>) { if (!env.CONVEX_URL) throw new Error('CONVEX_URL is required.'); return new NativeObjectStore(ServiceTransport.fromEnv(env), env.CONVEX_URL, Number(env.MAX_UPLOAD_BYTES) || undefined, env.CONVEX_SITE_URL); }
}
