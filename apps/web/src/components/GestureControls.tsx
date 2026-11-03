'use client';
import { useEffect, useRef, useState } from 'react';
import { GestureCamera, type GestureCameraState } from '@/lib/gesture-camera';
import { captureCalibration, DEFAULT_CALIBRATION, GestureInterpreter, type Calibration, type GestureAction, type GestureMode, type Hand, type Point } from '@/lib/gestures';

export function GestureControls({ onAction, disabled = false, spatial = false }: { onAction: (action: GestureAction) => void; disabled?: boolean; spatial?: boolean }) {
  const video = useRef<HTMLVideoElement>(null), camera = useRef<GestureCamera | undefined>(undefined), interpreter = useRef(new GestureInterpreter()), action = useRef(onAction);
  const [state, setState] = useState<GestureCameraState>('off'), [message, setMessage] = useState('Camera off'), [mode, setMode] = useState<GestureMode>('point');
  const [mirrored, setMirrored] = useState(true), [palmHelp, setPalmHelp] = useState(false), [preferredHand, setPreferredHand] = useState<'any'|'Left'|'Right'>('any');
  const [calibration, setCalibration] = useState<Calibration>(DEFAULT_CALIBRATION), [calibrating, setCalibrating] = useState<false | 'top-left' | 'bottom-right'>(false), firstCorner = useRef<Point | undefined>(undefined);
  const [observed, setObserved] = useState('No hand detected'), [elapsed, setElapsed] = useState(0), latest = useRef<Hand[] | undefined>(undefined);
  const options = useRef({mode, mirrored, palmHelp, preferredHand, calibration, calibrating});
  options.current = {mode, mirrored, palmHelp, preferredHand, calibration, calibrating}; action.current = onAction;
  useEffect(() => {
    if (!video.current) return;
    camera.current = new GestureCamera(video.current, (next, text) => { setState(next); setMessage(text); }, (hands, ms) => {
      latest.current = hands; setElapsed(Math.round(ms));
      setObserved(hands.length === 1 ? `${hands[0]!.handedness} hand · ${hands[0]!.gesture.replaceAll('_', ' ')} · ${Math.round(hands[0]!.confidence * 100)}%` : hands.length > 1 ? 'Choose one hand in Hand preference' : 'No hand detected');
      if (!options.current.calibrating) interpreter.current.update(hands, performance.now(), options.current).forEach(value => action.current(value));
    });
    const hide = () => { if (document.hidden) camera.current?.disable(); };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); camera.current?.disable(); interpreter.current.reset().forEach(value => action.current(value)); };
  }, []);
  useEffect(() => { interpreter.current.reset().forEach(value => action.current(value)); }, [mode, mirrored, preferredHand, calibration, calibrating, spatial]);
  useEffect(() => { if ((spatial && (mode === 'draw' || mode === 'pan')) || (!spatial && mode === 'rotate')) setMode('point'); }, [spatial, mode]);
  useEffect(() => { if (disabled) camera.current?.disable(); }, [disabled]);
  const active = !['off', 'error'].includes(state);
  function capture() {
    const hand = latest.current?.filter(value => preferredHand === 'any' || value.handedness === preferredHand);
    if (hand?.length !== 1 || !hand[0]!.landmarks[8]) { setMessage('Hold one clearly visible pointing finger before capturing a corner.'); return; }
    const point = hand[0]!.landmarks[8]!, value = { x: mirrored ? 1 - point.x : point.x, y: point.y };
    if (calibrating === 'top-left') { firstCorner.current = value; setCalibrating('bottom-right'); }
    else if (firstCorner.current) { try { setCalibration(captureCalibration(firstCorner.current, value)); setCalibrating(false); setMessage('Calibration saved for this camera session.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Please try calibration again.'); } }
  }
  return <section className="gesture-controls" aria-label="Camera gesture controls">
    <div className="gesture-summary"><strong>Optional hand controls</strong><span role="status">{message}</span><button className="small-button" disabled={disabled && !active} onClick={() => active ? camera.current?.disable() : void camera.current?.enable()}>{active ? 'Disable camera gestures' : 'Enable camera gestures'}</button></div>
    <details><summary>Gesture settings and camera preview</summary>
      <p>Video stays on this device. Pointing moves the cursor; pinch to select. Choose Draw to draw with an index finger, Pan or Rotate with a closed fist, or Zoom by changing the thumb–finger gap. Mouse, touch and keyboard controls remain available.</p>
      <div className="gesture-options"><label>Gesture mode<select value={mode} onChange={event => setMode(event.target.value as GestureMode)} disabled={disabled}><option value="point">Point</option><option value="draw" disabled={spatial}>Draw</option><option value="pan" disabled={spatial}>Pan</option><option value="zoom">Zoom</option><option value="rotate" disabled={!spatial}>Rotate</option></select></label><label>Hand preference<select value={preferredHand} onChange={event => setPreferredHand(event.target.value as typeof preferredHand)}><option value="any">One hand, either side</option><option value="Left">Left hand</option><option value="Right">Right hand</option></select></label><label><input type="checkbox" checked={mirrored} onChange={event => { setMirrored(event.target.checked); setCalibration(DEFAULT_CALIBRATION); }}/> Mirror camera</label><label><input type="checkbox" checked={palmHelp} onChange={event => setPalmHelp(event.target.checked)}/> Enable palm help</label></div>
      <p>Palm help: hold an open palm for 1.2 seconds to prepare a question about the selection, then press Send. It has an eight-second cooldown and never infers emotion or understanding.</p>
      <div className="gesture-preview"><video ref={video} muted playsInline aria-label="Local camera preview" style={{transform: mirrored ? 'scaleX(-1)' : undefined}}/><span>{observed}</span>{calibrating && <strong>Point at your comfortable {calibrating} corner</strong>}</div>
      <div className="gesture-actions"><button className="subtle-button" disabled={state !== 'ready'} onClick={() => setCalibrating('top-left')}>Calibrate pointer</button>{calibrating && <><button className="small-button" onClick={capture}>Capture {calibrating}</button><button className="subtle-button" onClick={() => setCalibrating(false)}>Cancel calibration</button></>}<button className="subtle-button" onClick={() => { setCalibration(DEFAULT_CALIBRATION); setCalibrating(false); }}>Reset calibration</button><button className="subtle-button" disabled={disabled} onClick={() => action.current({ type: 'help' })}>Ask about selection</button></div>
      {state === 'ready' && <p className="gesture-measurement">Last local inference: {elapsed} ms. Tracking slows automatically on busy devices; this is not an audio-latency measurement.</p>}
      {state === 'error' && <p role="alert">{message}</p>}
    </details>
  </section>;
}
