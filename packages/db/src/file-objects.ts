import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from './types.js';
import type { ObjectStore, ObjectMetadata } from './objects.js';
/** Isolated compatibility/test file storage; not the Convex production adapter. */
export class FileObjectStore implements ObjectStore {
  constructor(private readonly directory: string, private readonly maxBytes = 20 * 1024 * 1024) {}
  private file(key: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,499}$/.test(key) || key.split('/').some(part => !part || part === '..' || part === '.')) throw new StoreError(400, 'INVALID_OBJECT_KEY', 'Invalid storage object.');
    const root = path.resolve(this.directory), target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep)) throw new StoreError(400, 'INVALID_OBJECT_KEY', 'Invalid storage object.'); return target;
  }
  async health() { try { await mkdir(this.directory, { recursive: true }); return true; } catch { return false; } }
  async put(key: string, body: Uint8Array, contentType: string, options: { checksum?: string; signal?: AbortSignal } = {}) {
    if (!body.byteLength || body.byteLength > this.maxBytes) throw new StoreError(413, 'OBJECT_TOO_LARGE', 'This file exceeds the upload limit.');
    const checksum = createHash('sha256').update(body).digest('hex'); if (options.checksum && options.checksum !== checksum) throw new StoreError(400, 'CHECKSUM_MISMATCH', 'The file checksum did not match.');
    const file = this.file(key), temporary = `${file}.${randomUUID()}.tmp`, metadata = { size: body.byteLength, contentType, checksum };
    await mkdir(path.dirname(file), { recursive: true });
    try { await writeFile(temporary, JSON.stringify({ metadata, base64: Buffer.from(body).toString('base64') }), { mode: 0o600, signal: options.signal }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
    return metadata;
  }
  private async record(key: string): Promise<{ metadata: ObjectMetadata; base64: string }> { try { return JSON.parse(await readFile(this.file(key), 'utf8')); } catch (error) { if (error instanceof StoreError) throw error; throw new StoreError(404, 'OBJECT_MISSING', 'Saved file is not available.'); } }
  async head(key: string) { return (await this.record(key)).metadata; }
  async get(key: string, options: { maxBytes?: number; signal?: AbortSignal } = {}) { if (options.signal?.aborted) throw new StoreError(409, 'DOWNLOAD_CANCELLED', 'The download was cancelled.'); const record = await this.record(key); if (record.metadata.size > Math.min(this.maxBytes, options.maxBytes ?? this.maxBytes)) throw new StoreError(413, 'OBJECT_TOO_LARGE', 'This file exceeds the download limit.'); return { body: Buffer.from(record.base64, 'base64'), metadata: record.metadata }; }
  async delete(key: string) { await unlink(this.file(key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  close() {}
}
