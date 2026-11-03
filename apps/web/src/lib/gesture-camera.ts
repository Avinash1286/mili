import type { Hand } from './gestures';
export type GestureCameraState = 'off' | 'permission' | 'loading' | 'ready' | 'error';
type Engine = { recognizeForVideo: (video: HTMLVideoElement, now: number) => { landmarks: {x:number;y:number}[][]; gestures: {categoryName:string;score:number}[][]; handedness: {categoryName:string}[][] }; close: () => void };
/** Owns all camera/worker resources; epochs reject permission/model callbacks after disable. */
export class GestureCamera {
  private epoch = 0; private stream?: MediaStream; private worker?: Worker; private engine?: Engine;
  private frame = 0; private timeout?: ReturnType<typeof setTimeout>; private frameTimeout?: ReturnType<typeof setTimeout>; private busy = false; private lastFrame = 0; private interval = 100;
  constructor(private readonly video: HTMLVideoElement, private readonly onState: (state: GestureCameraState, message: string) => void, private readonly onHands: (hands: Hand[], elapsedMs: number) => void) {}
  async enable() {
    this.disable(); const epoch = this.epoch;
    this.onState('permission', 'Waiting for camera permission…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires localhost or HTTPS and a supported browser.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream; this.video.srcObject = stream;
      stream.getVideoTracks().forEach(track => { track.onended = () => { if (epoch === this.epoch) this.fail('The camera disconnected. Your keyboard and mouse controls still work.'); }; });
      await this.video.play(); if (epoch !== this.epoch) return;
      this.onState('loading', 'Camera on · loading local hand tracking…');
      this.timeout = setTimeout(() => { if (epoch === this.epoch) this.fail('Hand tracking took too long to load. Camera stopped; try again or use the board controls.'); }, 25000);
      if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
        const worker = new Worker('/gesture-worker.js', { type: 'module' }); this.worker = worker;
        worker.onmessage = ({ data }: MessageEvent<{type:string; hands?:Hand[]; elapsedMs?:number;message?:string}>) => {
          if (epoch !== this.epoch) return;
          if (data.type === 'ready') this.ready(epoch);
          else if (data.type === 'result') { clearTimeout(this.frameTimeout); this.busy = false; this.interval = Math.max(100, Math.min(500, (data.elapsedMs ?? 0) * 3)); this.onHands(data.hands ?? [], data.elapsedMs ?? 0); }
          else if (data.type === 'error') this.fail(data.message ?? 'Hand tracking failed.');
        };
        worker.onerror = () => { if (epoch === this.epoch) this.fail('This browser could not run local hand tracking. Camera stopped; keyboard controls remain available.'); };
        worker.postMessage({ type: 'init' });
      } else {
        const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision');
        if (epoch !== this.epoch) return;
        const vision = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
        if (epoch !== this.epoch) return;
        const engine = await GestureRecognizer.createFromOptions(vision, { baseOptions: { modelAssetPath: '/vendor/mediapipe/gesture_recognizer.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .65, minHandPresenceConfidence: .65, minTrackingConfidence: .65 });
        if (epoch !== this.epoch) { engine.close(); return; } this.engine = engine; this.ready(epoch);
      }
    } catch (error) { if (epoch === this.epoch) this.fail(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Camera permission was denied. You can keep using touch, mouse or keyboard.' : error instanceof Error ? error.message : 'The camera could not start.'); }
  }
  private ready(epoch: number) {
    clearTimeout(this.timeout); this.onState('ready', this.worker ? 'Camera on · tracking locally in a worker' : 'Camera on · throttled local tracking');
    const tick = async (now: number) => {
      if (epoch !== this.epoch) return;
      this.frame = requestAnimationFrame(tick);
      if (this.busy || now - this.lastFrame < this.interval || this.video.readyState < 2) return;
      this.lastFrame = now; this.busy = true;
      try {
        if (this.worker) {
          const bitmap = await createImageBitmap(this.video);
          if (epoch !== this.epoch || !this.worker) { bitmap.close(); return; }
          try { this.worker.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]); }
          catch (error) { bitmap.close(); throw error; }
          this.frameTimeout = setTimeout(() => { if(epoch === this.epoch) this.fail('Hand tracking stopped responding. Camera stopped; use the board controls or try again.'); }, 5000);
        } else if (this.engine) {
          const start = performance.now(), result = this.engine.recognizeForVideo(this.video, now), elapsed = performance.now() - start;
          this.interval = Math.max(120, Math.min(600, elapsed * 4)); this.busy = false;
          this.onHands(result.landmarks.map((landmarks,i) => ({landmarks, gesture:result.gestures[i]?.[0]?.categoryName??'None', confidence:result.gestures[i]?.[0]?.score??0, handedness:result.handedness[i]?.[0]?.categoryName??''})), elapsed);
        }
      } catch { if (epoch === this.epoch) this.fail('The camera frame could not be processed. Camera stopped.'); }
    };
    this.frame = requestAnimationFrame(tick);
  }
  private fail(message: string) { this.disable(); this.onState('error', message); }
  disable() {
    this.epoch++; cancelAnimationFrame(this.frame); clearTimeout(this.timeout); clearTimeout(this.frameTimeout); this.busy = false; this.lastFrame = 0;
    this.worker?.terminate(); this.worker = undefined; this.engine?.close(); this.engine = undefined;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = undefined;
    this.video.pause(); this.video.srcObject = null; this.onHands([], 0); this.onState('off', 'Camera off');
  }
}
