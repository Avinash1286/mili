import { TeachingBeatProposalSchema, type TeachingBeatProposal } from '../../packages/contracts/src/index.js';

export const SPATIAL_REQUEST = 'Show DNA and highlight a base pair.';
export const SPATIAL_SEQUENCE_REQUEST = 'Show a DNA base pair, then the left ventricle.';

/** Catalog-backed proposals still pass through the production teaching validator. */
export function spatialReply(sequence = false) {
  const beats: TeachingBeatProposal[] = [TeachingBeatProposalSchema.parse({
    spokenText: 'A DNA base pair joins complementary bases across the double helix.',
    displayText: 'A base pair joins complementary DNA bases: A with T, or C with G.',
    spatialUpdate: { modelId: 'dna', assetVersion: '1.0.0', partIds: ['base-pair'] },
  })];
  if (sequence) beats.push(TeachingBeatProposalSchema.parse({
    spokenText: 'The left ventricle pumps oxygen-rich blood to the body through the aorta.',
    displayText: 'The left ventricle pumps oxygen-rich blood into the aorta.',
    spatialUpdate: { modelId: 'heart', assetVersion: '1.0.0', partIds: ['left-ventricle'] },
  }));
  return { text: beats.map(beat => beat.displayText).join(' '), beats };
}
