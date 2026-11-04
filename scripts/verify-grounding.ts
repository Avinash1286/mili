import { createCanvas } from '../packages/grounding/node_modules/@napi-rs/canvas';
import { ingestSource, embedQuery } from '../packages/grounding/src/index';

async function main() {
  const canvas = createCanvas(1400, 400), context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 1400, 400); context.fillStyle = 'black'; context.font = '40px Arial';
  context.fillText('Photosynthesis uses light energy to make sugar.', 40, 90);
  context.fillText('Plants take in carbon dioxide from the air.', 40, 170);
  const result = await ingestSource({ bytes: canvas.toBuffer('image/png'), mime: 'image/png', sourceId: 'synthetic-ocr', revision: 0 });
  if (!result.chunks.some(chunk => /photosynthesis/i.test(chunk.text)) || result.chunks.some(chunk => chunk.embedding?.length !== 384)) throw new Error('Actual OCR/embedding check failed.');
  const vector = await embedQuery('How do plants use sunlight?');
  const cosine = result.chunks[0]!.embedding!.reduce((sum, value, index) => sum + value * vector[index]!, 0);
  if (cosine < .3) throw new Error('The semantic retrieval smoke check did not match its related source.');
  console.info(JSON.stringify({ actualOcr: true, pages: result.pages, chunks: result.chunks.length, embeddingDimensions: vector.length, relatedSimilarity: Number(cosine.toFixed(3)), metrics: result.metrics }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Grounding check failed.'); process.exitCode = 1; });
