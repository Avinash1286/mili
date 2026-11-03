import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
env.allowRemoteModels = false;
env.localModelPath = resolve(root, '.tokai-models') + '/';
env.useFSCache = false;
let extractor: Promise<FeatureExtractionPipeline> | undefined;
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length || texts.length > 150 || texts.some(text => !text.trim() || text.length > 4000)) throw new Error('Invalid embedding input.');
  extractor ??= pipeline('feature-extraction', 'minilm', { dtype: 'fp32', device: 'cpu' }) as Promise<FeatureExtractionPipeline>;
  const model = await extractor, embeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += 8) {
    const output = await model(texts.slice(offset, offset + 8), { pooling: 'mean', normalize: true });
    const batch = output.tolist() as number[][];
    if (batch.some(vector => vector.length !== 384 || vector.some(value => !Number.isFinite(value)))) throw new Error('The embedding model returned an invalid vector.');
    embeddings.push(...batch);
  }
  return embeddings;
}
