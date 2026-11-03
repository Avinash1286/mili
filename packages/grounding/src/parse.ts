import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createWorker, type Worker } from 'tesseract.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SOURCE_PAGES, MAX_SOURCE_TEXT, validateUpload, type ParsedPage, type SourceMime } from './content.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/** Runs only in a bounded child process; no provider credentials or arbitrary URLs. */
export async function parseSource(bytes: Uint8Array, mime: SourceMime): Promise<ParsedPage[]> {
  validateUpload(bytes, mime);
  if (mime === 'text/plain') return [{ page: 1, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), method: 'text' }];
  let ocr: Worker | undefined;
  const recognize = async (image: Buffer) => {
    ocr ??= await createWorker('eng', 1, { langPath: resolve(root, '.tokai-models/ocr'), gzip: false, cacheMethod: 'none', logger: () => {}, errorHandler: () => {} });
    const result = await ocr.recognize(image);
    return { text: result.data.text, confidence: result.data.confidence };
  };
  try {
    if (mime !== 'application/pdf') return [{ page: 1, ...await recognize(Buffer.from(bytes)), method: 'ocr' }];
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, stopAtErrors: true, maxImageSize: 4_000_000, useSystemFonts: false });
    const document = await task.promise;
    try {
      if (document.numPages > MAX_SOURCE_PAGES) throw new Error('PDFs are limited to 20 pages.');
      const pages: ParsedPage[] = []; let total = 0;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), content = await page.getTextContent();
        let text = content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').trim();
        let method: ParsedPage['method'] = 'text', confidence: number | undefined;
        if (text.length < 40) {
          const original = page.getViewport({ scale: 1 });
          const scale = Math.min(1.75, Math.sqrt(4_000_000 / (original.width * original.height)));
          const viewport = page.getViewport({ scale });
          if (!Number.isFinite(viewport.width) || viewport.width < 1 || viewport.height < 1) throw new Error('Invalid PDF page dimensions.');
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise;
          const result = await recognize(canvas.toBuffer('image/png')); text = result.text; confidence = result.confidence; method = 'ocr';
        }
        total += text.length; if (total > MAX_SOURCE_TEXT) throw new Error('The extracted document text exceeds 200,000 characters.');
        pages.push({ page: number, text, method, ...(confidence === undefined ? {} : { confidence }) }); page.cleanup();
      }
      return pages;
    } finally { await task.destroy(); }
  } finally { await ocr?.terminate(); }
}
