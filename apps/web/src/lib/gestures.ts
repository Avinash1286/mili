/** Browser-local hand interpretation. Neither images nor landmarks enter the API. */
export type GestureMode = 'point' | 'draw' | 'pan' | 'zoom' | 'rotate';
export type Point = { x: number; y: number };
export type Hand = { landmarks: Point[]; gesture: string; confidence: number; handedness: string };
export type Calibration = { left: number; top: number; right: number; bottom: number };
export type GestureAction =
  | { type: 'pointer' | 'select' | 'draw.start' | 'draw.move'; point: Point }
  | { type: 'draw.end' | 'help' | 'lost' }
  | { type: 'pan' | 'rotate'; delta: Point }
  | { type: 'zoom'; factor: number };
export const DEFAULT_CALIBRATION: Calibration = { left: .1, top: .1, right: .9, bottom: .9 };
const bounded = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
export function calibratedPoint(point: Point, mirrored: boolean, calibration: Calibration): Point {
  const x = mirrored ? 1 - point.x : point.x;
  return { x: bounded((x - calibration.left) / (calibration.right - calibration.left)), y: bounded((point.y - calibration.top) / (calibration.bottom - calibration.top)) };
}
export function captureCalibration(a: Point, b: Point): Calibration {
  if (![a.x, a.y, b.x, b.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) || b.x - a.x < .15 || b.y - a.y < .15) throw new Error('Keep the top-left and bottom-right positions at least a hand-width apart within the camera view.');
  return { left: bounded(a.x), top: bounded(a.y), right: bounded(b.x), bottom: bounded(b.y) };
}
export class GestureInterpreter {
  private previous?: Point;
  private pose = ''; private since = 0; private drawing = false; private pinched = false; private pinchDistance?: number;
  private helpLatched = false; private lastHelp = -Infinity;
  reset(): GestureAction[] { const actions: GestureAction[] = this.drawing ? [{ type: 'draw.end' }] : []; this.previous = undefined; this.pose = ''; this.drawing = false; this.pinched = false; this.pinchDistance = undefined; this.helpLatched = false; return actions; }
  update(hands: Hand[], now: number, options: { mode: GestureMode; mirrored: boolean; calibration: Calibration; palmHelp: boolean; preferredHand: 'any' | 'Left' | 'Right' }): GestureAction[] {
    const candidates = hands.filter(hand => options.preferredHand === 'any' || hand.handedness === options.preferredHand);
    if (candidates.length !== 1 || candidates[0]!.landmarks.length < 21 || !Number.isFinite(candidates[0]!.confidence) || candidates[0]!.confidence < .65 || candidates[0]!.confidence > 1 || !candidates[0]!.landmarks.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return [...this.reset(), { type: 'lost' }];
    const hand = candidates[0]!, raw = calibratedPoint(hand.landmarks[8]!, options.mirrored, options.calibration), old = this.previous;
    const point = old ? { x: old.x + .35 * (raw.x - old.x), y: old.y + .35 * (raw.y - old.y) } : raw;
    const delta = old ? { x: point.x - old.x, y: point.y - old.y } : { x: 0, y: 0 };
    this.previous = Math.hypot(delta.x, delta.y) < .003 && old ? old : point;
    const actions: GestureAction[] = [{ type: 'pointer', point: this.previous }];
    if (hand.gesture !== this.pose) { this.pose = hand.gesture; this.since = now; this.pinchDistance = undefined; }
    if (this.pose !== 'Open_Palm') this.helpLatched = false;
    if (options.palmHelp && this.pose === 'Open_Palm' && now - this.since >= 1200 && !this.helpLatched && now - this.lastHelp >= 8000) { this.helpLatched = true; this.lastHelp = now; actions.push({ type: 'help' }); }
    const distance = (a: number, b: number) => Math.hypot(hand.landmarks[a]!.x - hand.landmarks[b]!.x, hand.landmarks[a]!.y - hand.landmarks[b]!.y);
    const pinch = distance(4, 8) / Math.max(.03, distance(5, 17));
    if (pinch > .55) this.pinched = false;
    if (options.mode === 'point' && pinch < .35 && !this.pinched && now - this.since > 250) { this.pinched = true; actions.push({ type: 'select', point }); }
    const drawing = options.mode === 'draw' && this.pose === 'Pointing_Up' && now - this.since > 250;
    if (drawing) { actions.push({ type: this.drawing ? 'draw.move' : 'draw.start', point }); this.drawing = true; }
    else if (this.drawing) { actions.push({ type: 'draw.end' }); this.drawing = false; }
    if ((options.mode === 'pan' || options.mode === 'rotate') && this.pose === 'Closed_Fist' && now - this.since > 250 && Math.hypot(delta.x, delta.y) >= .003) actions.push({ type: options.mode, delta });
    if (options.mode === 'zoom' && pinch < 1.5 && now - this.since > 250) {
      if (this.pinchDistance && pinch > .05) actions.push({ type: 'zoom', factor: bounded(pinch / this.pinchDistance, .85, 1.15) });
      this.pinchDistance = Math.max(.05, pinch);
    }
    return actions;
  }
}
