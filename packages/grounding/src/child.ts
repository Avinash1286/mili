import { parseSource } from './parse.js';
import { embedTexts } from './embeddings.js';
import { chunkPages, type SourceMime } from './content.js';

process.once('message', async (input: { bytes?: Uint8Array; mime?: SourceMime; sourceId?: string; revision?: number; texts?: string[] }) => {
  const started = performance.now(), cpu = process.cpuUsage(); let peakRssBytes = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 25);
  const metrics = () => { const used = process.cpuUsage(cpu); return { elapsedMs: Math.round(performance.now() - started), peakRssBytes: Math.max(peakRssBytes, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024), cpuMs: Math.round((used.user + used.system) / 1000) }; };
  try {
    if (input.texts) { process.send?.({ embeddings: await embedTexts(input.texts), metrics: metrics() }); return; }
    if (!input.bytes || !input.mime || !input.sourceId || input.revision === undefined) throw new Error('Missing input.');
    const pages = await parseSource(input.bytes, input.mime), chunks = chunkPages(input.sourceId, input.revision, pages);
    const vectors = await embedTexts(chunks.map(chunk => chunk.text));
    process.send?.({ pages: pages.length, chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] })), metrics: metrics() });
  } catch { process.send?.({ error: 'The document could not be processed. Check its type, page limit and readability, and verify the local OCR/embedding assets.' }); }
  finally { clearInterval(sample); process.disconnect(); }
});
