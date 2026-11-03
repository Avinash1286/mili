import { resolveSpatialSelection, type SpatialSelection } from '@tokai/contracts';
import { TutorError } from './types.js';

/** Only catalog-authored descriptions enter tutor context; client labels are never trusted. */
export function groundSpatialSelection(selection?: SpatialSelection) {
  if (!selection) return undefined;
  try { return resolveSpatialSelection(selection); }
  catch { throw new TutorError('INVALID_SPATIAL_SELECTION', 'The selected model or part is unavailable. Open the model and select it again.', 400); }
}
