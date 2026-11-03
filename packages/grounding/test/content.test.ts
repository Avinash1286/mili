import { describe, expect, it } from 'vitest';
import { chunkPages, validateUpload } from '../src/content.js';
describe('source boundaries and anchors', () => {
  it('rejects declared types and checksums that do not describe the uploaded bytes', () => {
    const content = Buffer.from('Ordinary lesson text.');
    expect(() => validateUpload(content, 'application/pdf')).toThrow('not a PDF');
    expect(() => validateUpload(content, 'text/plain', { bytes: content.length, checksum: '0'.repeat(64) })).toThrow('checksum');
    expect(() => validateUpload(Buffer.from([0xc0, 0xff]), 'text/plain')).toThrow();
    expect(() => validateUpload(Buffer.from('text\0payload'), 'text/plain')).toThrow('control');
  });
  it('rejects a PNG header declaring a decompression bomb before image decoding', () => {
    const image = Buffer.alloc(24); image.set([137,80,78,71,13,10,26,10]); image.writeUInt32BE(50000, 16); image.writeUInt32BE(50000, 20);
    expect(() => validateUpload(image, 'image/png')).toThrow('megapixels');
  });
  it('retains real page anchors across overlapping chunks and never joins different pages', () => {
    const chunks = chunkPages('owner-source', 2, [{ page: 3, text: 'Carbon dioxide supplies carbon. '.repeat(100), method: 'text' }, { page: 4, text: 'Water supplies oxygen.', method: 'ocr' }]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toMatchObject({ page: 3, sourceId: 'owner-source', revision: 2 });
    expect(chunks.at(-1)).toMatchObject({ page: 4, text: 'Water supplies oxygen.' });
    expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(chunks.length);
    expect(chunks.every(chunk => chunk.text.length <= 1800)).toBe(true);
  });
  it('fails empty or excessive documents instead of manufacturing evidence', () => {
    expect(() => chunkPages('source', 0, [{ page: 1, text: ' ', method: 'ocr' }])).toThrow('No readable text');
    expect(() => chunkPages('source', 0, Array.from({length:21}, (_, index) => ({page:index+1,text:'page',method:'text'})))).toThrow('page');
  });
});
