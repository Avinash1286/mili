import { describe, expect, it } from 'vitest';
import { calibratedPoint, captureCalibration, DEFAULT_CALIBRATION, GestureInterpreter, type GestureAction, type GestureMode, type Hand, type Point } from '../src/lib/gestures';

const options = (mode: GestureMode = 'point') => ({ mode, mirrored: false, calibration: { left: 0, top: 0, right: 1, bottom: 1 }, palmHelp: false, preferredHand: 'any' as 'any' | 'Left' | 'Right' });
function hand({ point = { x: .5, y: .5 }, pinch = 1, gesture = 'Pointing_Up', confidence = .9, handedness = 'Right' }: { point?: Point; pinch?: number; gesture?: string; confidence?: number; handedness?: string } = {}): Hand {
  const landmarks = Array.from({ length: 21 }, () => ({ x: .5, y: .5 }));
  landmarks[5] = { x: .4, y: .7 }; landmarks[17] = { x: .6, y: .7 };
  landmarks[8] = point; landmarks[4] = { x: point.x + (point.x < .5 ? 1 : -1) * pinch * .2, y: point.y };
  return { landmarks, gesture, confidence, handedness };
}
function pointer(actions: GestureAction[]): Point {
  const action = actions.find(value => value.type === 'pointer');
  if (!action || !('point' in action)) throw new Error('Expected a tracked pointer');
  return action.point;
}
const types = (actions: GestureAction[]) => actions.map(action => action.type);

describe('gesture calibration and stable pointing', () => {
  it('maps mirrored and unmirrored points into the calibrated region and clamps its edges', () => {
    expect(calibratedPoint({ x: .2, y: .5 }, false, DEFAULT_CALIBRATION).x).toBeCloseTo(.125);
    expect(calibratedPoint({ x: .2, y: .5 }, true, DEFAULT_CALIBRATION).x).toBeCloseTo(.875);
    expect(calibratedPoint({ x: .2, y: .5 }, true, DEFAULT_CALIBRATION).y).toBeCloseTo(.5);
    expect(calibratedPoint({ x: 0, y: 1 }, false, DEFAULT_CALIBRATION)).toEqual({ x: 0, y: 1 });
  });
  it('accepts a usable calibration and rejects reversed, tiny, nonfinite and out-of-range bounds', () => {
    expect(captureCalibration({ x: .2, y: .25 }, { x: .8, y: .75 })).toEqual({ left: .2, top: .25, right: .8, bottom: .75 });
    for (const [a, b] of [
      [{ x: .5, y: .2 }, { x: .4, y: .9 }],
      [{ x: .2, y: .2 }, { x: .3, y: .9 }],
      [{ x: NaN, y: .2 }, { x: .8, y: .9 }],
      [{ x: -2, y: -2 }, { x: -1, y: -1 }],
      [{ x: 1.1, y: 1.1 }, { x: 1.5, y: 1.5 }],
    ] as [Point, Point][]) expect(() => captureCalibration(a, b)).toThrow();
  });
  it('smooths actual movement while suppressing tiny pointer jitter', () => {
    const interpreter = new GestureInterpreter();
    expect(pointer(interpreter.update([hand({ point: { x: .2, y: .5 } })], 0, options()))).toEqual({ x: .2, y: .5 });
    expect(pointer(interpreter.update([hand({ point: { x: .201, y: .501 } })], 100, options()))).toEqual({ x: .2, y: .5 });
    const moved = pointer(interpreter.update([hand({ point: { x: .8, y: .7 } })], 200, options()));
    expect(moved.x).toBeCloseTo(.41); expect(moved.y).toBeCloseTo(.57);
    const next = pointer(interpreter.update([hand({ point: { x: .8, y: .7 } })], 300, options()));
    expect(next.x).toBeGreaterThan(moved.x); expect(next.x).toBeLessThan(.8);
  });
  it('drops ambiguous, incomplete, nonfinite or low-confidence hands without emitting actions', () => {
    const malformed = hand(); malformed.landmarks[8] = { x: NaN, y: .5 };
    const short = hand(); short.landmarks = short.landmarks.slice(0, 20);
    for (const hands of [[], [hand(), hand()], [malformed], [short], [hand({ confidence: .64 })], [hand({ confidence: 1.1 })], [hand({ confidence: NaN })], [hand({ confidence: Infinity })]]) {
      const interpreter = new GestureInterpreter();
      expect(interpreter.update(hands, 1000, options())).toEqual([{ type: 'lost' }]);
    }
  });
  it('uses one explicitly preferred hand and rejects missing or duplicate preferred hands', () => {
    const interpreter = new GestureInterpreter(), config = { ...options(), preferredHand: 'Left' as const };
    const left = hand({ handedness: 'Left', point: { x: .25, y: .5 } }), right = hand({ handedness: 'Right', point: { x: .75, y: .5 } });
    expect(pointer(interpreter.update([right, left], 0, config)).x).toBe(.25);
    expect(interpreter.update([right], 100, config)).toEqual([{ type: 'lost' }]);
    expect(interpreter.update([left, left], 200, config)).toEqual([{ type: 'lost' }]);
  });
  it('starts fresh after tracking loss instead of dragging the old smoothed position', () => {
    const interpreter = new GestureInterpreter();
    interpreter.update([hand({ point: { x: .2, y: .2 } })], 0, options());
    interpreter.update([], 100, options());
    expect(pointer(interpreter.update([hand({ point: { x: .8, y: .8 } })], 200, options()))).toEqual({ x: .8, y: .8 });
  });
});

describe('deliberate gesture actions', () => {
  it('selects once per held pinch and rearms only after a clear release', () => {
    const interpreter = new GestureInterpreter(), config = options();
    expect(types(interpreter.update([hand({ pinch: .2 })], 0, config))).toEqual(['pointer']);
    expect(types(interpreter.update([hand({ pinch: .2 })], 249, config))).toEqual(['pointer']);
    expect(types(interpreter.update([hand({ pinch: .2 })], 251, config))).toEqual(['pointer', 'select']);
    expect(types(interpreter.update([hand({ pinch: .2 })], 500, config))).toEqual(['pointer']);
    interpreter.update([hand({ pinch: .45 })], 600, config);
    expect(types(interpreter.update([hand({ pinch: .2 })], 700, config))).toEqual(['pointer']);
    interpreter.update([hand({ pinch: .7 })], 800, config);
    expect(types(interpreter.update([hand({ pinch: .2 })], 900, config))).toEqual(['pointer', 'select']);
  });
  it('waits for a stable drawing pose and ends the stroke exactly once on tracking loss', () => {
    const interpreter = new GestureInterpreter(), config = options('draw');
    expect(types(interpreter.update([hand()], 0, config))).toEqual(['pointer']);
    expect(types(interpreter.update([hand()], 250, config))).toEqual(['pointer']);
    expect(types(interpreter.update([hand()], 251, config))).toEqual(['pointer', 'draw.start']);
    expect(types(interpreter.update([hand({ point: { x: .7, y: .5 } })], 300, config))).toEqual(['pointer', 'draw.move']);
    expect(interpreter.update([], 400, config)).toEqual([{ type: 'draw.end' }, { type: 'lost' }]);
    expect(interpreter.update([], 500, config)).toEqual([{ type: 'lost' }]);
    expect(types(interpreter.update([hand()], 600, config))).toEqual(['pointer']);
  });
  it('ends drawing when the pose or mode changes and resets an active stroke safely', () => {
    for (const change of ['pose', 'mode', 'reset'] as const) {
      const interpreter = new GestureInterpreter();
      interpreter.update([hand()], 0, options('draw')); interpreter.update([hand()], 251, options('draw'));
      const actions = change === 'reset' ? interpreter.reset() : interpreter.update([hand({ gesture: change === 'pose' ? 'Closed_Fist' : 'Pointing_Up' })], 300, options(change === 'mode' ? 'point' : 'draw'));
      expect(types(actions)).toContain('draw.end');
      expect(interpreter.reset()).toEqual([]);
    }
  });
  for (const mode of ['pan', 'rotate'] as const) it(`${mode} requires a stable fist and ignores jitter or the wrong pose`, () => {
    const interpreter = new GestureInterpreter(), config = options(mode);
    interpreter.update([hand({ gesture: 'Closed_Fist' })], 0, config);
    expect(types(interpreter.update([hand({ gesture: 'Closed_Fist', point: { x: .501, y: .5 } })], 251, config))).toEqual(['pointer']);
    const actions = interpreter.update([hand({ gesture: 'Closed_Fist', point: { x: .7, y: .6 } })], 300, config);
    const move = actions.find(action => action.type === mode);
    expect(move).toBeDefined();
    if (!move || !('delta' in move)) throw new Error('Missing movement');
    expect(move.delta.x).toBeCloseTo(.07); expect(move.delta.y).toBeCloseTo(.035);
    expect(types(interpreter.update([hand({ gesture: 'Pointing_Up', point: { x: .9, y: .8 } })], 700, config))).toEqual(['pointer']);
  });
  it('zooms from a stable distance baseline with bounded ratios and no singular division', () => {
    const interpreter = new GestureInterpreter(), config = options('zoom');
    interpreter.update([hand({ gesture: 'None', pinch: .6 })], 0, config);
    expect(types(interpreter.update([hand({ gesture: 'None', pinch: .6 })], 251, config))).toEqual(['pointer']);
    expect(interpreter.update([hand({ gesture: 'None', pinch: 1.2 })], 300, config)).toContainEqual({ type: 'zoom', factor: 1.15 });
    expect(interpreter.update([hand({ gesture: 'None', pinch: .1 })], 350, config)).toContainEqual({ type: 'zoom', factor: .85 });
    expect(types(interpreter.update([hand({ gesture: 'None', pinch: 0 })], 400, config))).toEqual(['pointer']);
    expect(interpreter.update([hand({ gesture: 'None', pinch: .2 })], 450, config)).toContainEqual({ type: 'zoom', factor: 1.15 });
    expect(types(interpreter.update([hand({ gesture: 'None', pinch: 2 })], 500, config))).toEqual(['pointer']);
  });
});

describe('opt-in palm help', () => {
  it('never requests help while the preference is disabled', () => {
    const interpreter = new GestureInterpreter();
    for (const now of [0, 1200, 8000, 20000]) expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], now, options()))).not.toContain('help');
  });
  it('requires a dwell, emits once for a held palm, and rearms after a new pose', () => {
    const interpreter = new GestureInterpreter(), config = { ...options(), palmHelp: true };
    interpreter.update([hand({ gesture: 'Open_Palm' })], 0, config);
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 1199, config))).not.toContain('help');
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 1200, config))).toContain('help');
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 15000, config))).not.toContain('help');
    interpreter.update([hand({ gesture: 'Closed_Fist' })], 15001, config);
    interpreter.update([hand({ gesture: 'Open_Palm' })], 15002, config);
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 16201, config))).not.toContain('help');
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 16202, config))).toContain('help');
  });
  it('retains the cooldown across tracking loss and explicit reset', () => {
    const interpreter = new GestureInterpreter(), config = { ...options(), palmHelp: true };
    interpreter.update([hand({ gesture: 'Open_Palm' })], 0, config);
    interpreter.update([hand({ gesture: 'Open_Palm' })], 1200, config);
    interpreter.update([], 1300, config); interpreter.reset();
    interpreter.update([hand({ gesture: 'Open_Palm' })], 1400, config);
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 2600, config))).not.toContain('help');
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 9199, config))).not.toContain('help');
    expect(types(interpreter.update([hand({ gesture: 'Open_Palm' })], 9200, config))).toContain('help');
  });
});
