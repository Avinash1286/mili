/** Browser/Convex-safe signature and size validation, before native parsing. */
export function validateTransferContent(bytes: Uint8Array, mime: string, expected: number) {
  if (!bytes.length || bytes.length !== expected || bytes.length > 10 * 1024 * 1024) throw new Error('Upload size does not match.');
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'application/pdf') { if (ascii(0, 5) !== '%PDF-') throw new Error('Invalid PDF signature.'); return; }
  if (mime === 'text/plain') { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.length > 200000 || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error('Invalid text content.'); return; }
  let width = 0, height = 0;
  if (mime === 'image/png') {
    if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) throw new Error('Invalid PNG signature.');
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('Invalid JPEG signature.');
    for (let offset = 2; offset + 9 <= bytes.length;) {
      if (bytes[offset] !== 255) throw new Error('Invalid JPEG segment.');
      const marker = bytes[offset + 1]; offset += 2;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      const size = view.getUint16(offset); if (size < 2 || offset + size > bytes.length) throw new Error('Invalid JPEG segment.');
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; }
      offset += size;
    }
  } else throw new Error('Unsupported upload type.');
  if (!width || !height || width > 8000 || height > 8000 || width * height > 12000000) throw new Error('Invalid image dimensions.');
}
