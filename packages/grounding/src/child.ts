import { parseSource } from './parse.js';
import { embedTexts } from './embeddings.js';
import { chunkPages, type SourceMime } from './content.js';

process.once('message', async (input: { bytes?: Uint8Array; mime?: SourceMime; sourceId?: string; revision?: number; texts?: string[] }) => {
  try {
    if (input.texts) { process.send?.({ embeddings: await embedTexts(input.texts) }); return; }
    if (!input.bytes || !input.mime || !input.sourceId || input.revision === undefined) throw new Error('Missing input.');
    const pages = await parseSource(input.bytes, input.mime), chunks = chunkPages(input.sourceId, input.revision, pages);
    const vectors = await embedTexts(chunks.map(chunk => chunk.text));
    process.send?.({ pages: pages.length, chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] })) });
  } catch { process.send?.({ error: 'The document could not be processed. Check its type, page limit and readability, and verify the local OCR/embedding assets.' }); }
  finally { process.disconnect(); }
});
