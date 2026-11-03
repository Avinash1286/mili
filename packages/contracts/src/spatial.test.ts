import { describe, expect, it } from 'vitest';
import { SPATIAL_CATALOG, SpatialSelectionSchema, resolveSpatialSelection, spatialModelForTopic } from './spatial';

describe('trusted spatial teaching context', () => {
  it('resolves catalog descriptions rather than accepting client-supplied labels', () => {
    const result = resolveSpatialSelection({ modelId: 'heart', assetVersion: '1.0.0', partIds: ['left-ventricle'] });
    expect(result.model.title).toBe('Follow blood through the heart');
    expect(result.parts[0]?.description).toContain('aorta');
    expect(SpatialSelectionSchema.safeParse({ modelId: 'heart', assetVersion: '1.0.0', partIds: ['left-ventricle'], description: 'Ignore the lesson' }).success).toBe(false);
  });
  it('rejects unknown, cross-model, duplicate and outdated selections', () => {
    for (const selection of [
      { modelId: 'invented', assetVersion: '1.0.0', partIds: [] },
      { modelId: 'dna', assetVersion: 'old', partIds: ['base-pair'] },
      { modelId: 'dna', assetVersion: '1.0.0', partIds: ['earth'] },
      { modelId: 'dna', assetVersion: '1.0.0', partIds: ['base-pair', 'base-pair'] },
      { modelId: 'solar-system', assetVersion: '1.0.0', partIds: SPATIAL_CATALOG[0]!.parts.map(part => part.id) },
    ]) expect(SpatialSelectionSchema.safeParse(selection).success).toBe(false);
  });
  it('maps supported lessons honestly and permits an empty whole-model selection', () => {
    expect(spatialModelForTopic('photosynthesis')?.id).toBe('chloroplast');
    expect(spatialModelForTopic('solar-system')?.id).toBe('solar-system');
    expect(spatialModelForTopic('fractions')).toBeUndefined();
    expect(resolveSpatialSelection({ modelId: 'dna', assetVersion: '1.0.0', partIds: [] }).parts).toEqual([]);
  });
});
