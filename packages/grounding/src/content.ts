import { createHash } from 'node:crypto';
import type { SourceChunk } from '@milli/db';

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_SOURCE_PAGES = 20;
export const MAX_SOURCE_TEXT = 200_000;
export const EMBEDDING_MODEL = 'all-MiniLM-L6-v2@aff7a1dc';
export type SourceMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain';
export type ParsedPage = { page: number; text: string; method: 'text' | 'ocr'; confidence?: number };
export function validateUpload(bytes: Uint8Array, mime: SourceMime, expected?: { bytes: number; checksum: string }) {
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error('Upload must be between 1 byte and 10 MiB.');
  const buffer = Buffer.from(bytes), checksum = createHash('sha256').update(buffer).digest('hex');
  if (expected && (buffer.length !== expected.bytes || checksum !== expected.checksum)) throw new Error('The upload size or checksum does not match its declared content.');
  if (mime === 'application/pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The uploaded document is not a PDF.');
  if (mime === 'image/png' && !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('The uploaded image is not a PNG.');
  if (mime === 'image/jpeg' && !(buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)) throw new Error('The uploaded image is not a JPEG.');
  if (mime === 'text/plain') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0') || /[\u0001-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error('Upload a UTF-8 text file without binary control characters.');
    if (text.length > MAX_SOURCE_TEXT) throw new Error('Text sources are limited to 200,000 characters.');
  }
  if (mime.startsWith('image/')) imageDimensions(buffer, mime as 'image/png'|'image/jpeg');
  return checksum;
}
export function imageDimensions(bytes: Buffer, mime: 'image/png'|'image/jpeg') {
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 24) { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  if (mime === 'image/jpeg') {
    for (let offset = 2; offset + 9 <= bytes.length;) {
      if (bytes[offset] !== 0xff) throw new Error('Invalid JPEG structure.');
      const marker = bytes[offset + 1]!; offset += 2;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = bytes.readUInt16BE(offset); if (size < 2 || offset + size > bytes.length) throw new Error('Invalid JPEG segment.');
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { height = bytes.readUInt16BE(offset+3); width = bytes.readUInt16BE(offset+5); break; }
      offset += size;
    }
  }
  if (!width || !height || width > 8000 || height > 8000 || width * height > 12_000_000) throw new Error('Images must have valid dimensions and at most 12 megapixels.');
  return { width, height };
}
export function chunkPages(sourceId: string, revision: number, pages: ParsedPage[]): SourceChunk[] {
  if (!pages.length || pages.length > MAX_SOURCE_PAGES || pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_SOURCE_TEXT) throw new Error('This source exceeds the page or extracted-text limit.');
  const chunks: SourceChunk[] = [];
  for (const page of pages) {
    const text = page.text.replace(/\s+/g, ' ').trim();
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 1800);
      if (end < text.length) { const boundary = text.lastIndexOf(' ', end); if (boundary > start + 1200) end = boundary; }
      const value = text.slice(start, end).trim();
      if (value) chunks.push({ id: `${sourceId}-${revision}-${chunks.length}`, sourceId, revision, ordinal: chunks.length, text: value, page: page.page, anchor: `Page ${page.page}` });
      if (end === text.length) break;
      start = Math.max(start + 1, end - 160);
    }
  }
  if (!chunks.length) throw new Error('No readable text was found. Try a clearer image or a text PDF.');
  if (chunks.length > 150) throw new Error('This source has too many text sections. Split it into smaller documents.');
  return chunks;
}
