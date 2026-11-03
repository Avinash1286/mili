import type { GestureAction } from './gestures';
export interface BoardInteractionAdapter { gesture(action: GestureAction): void }
