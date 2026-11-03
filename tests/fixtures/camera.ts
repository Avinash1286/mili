import type { Page } from '@playwright/test';

type CameraState = { attempts: number; stops: number; tracks: MediaStreamTrack[]; release: (() => void)[]; workerMessages: Record<string, number> };
type CameraWindow = Window & { __tokaiTestCamera?: CameraState };

/** Browser-only synthetic video source. It exercises lifecycle, never recognition accuracy. */
export async function fixtureCamera(page: Page, mode: 'denied' | 'immediate' | 'deferred' = 'immediate') {
  await page.addInitScript(({ mode }) => {
    const state: CameraState = { attempts: 0, stops: 0, tracks: [], release: [], workerMessages: {} };
    (window as CameraWindow).__tokaiTestCamera = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (new URL(String(url), window.location.href).pathname === '/gesture-worker.js') this.addEventListener('message', event => {
          const type = event.data?.type;
          if (type === 'ready' || type === 'result' || type === 'error') state.workerMessages[type] = (state.workerMessages[type] ?? 0) + 1;
        });
      }
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const stream = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 96;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#294c3f'; drawing.fillRect(0, 0, canvas.width, canvas.height);
      const result = canvas.captureStream(10);
      // Keep supplying blank frames so video.play() and real local inference can run.
      const frames = setInterval(() => {
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        for (const track of result.getVideoTracks()) (track as CanvasCaptureMediaStreamTrack).requestFrame?.();
      }, 100);
      for (const track of result.getTracks()) {
        state.tracks.push(track);
        const stop = track.stop.bind(track);
        track.stop = () => { if (track.readyState !== 'ended') state.stops++; stop(); if (result.getTracks().every(item => item.readyState === 'ended')) clearInterval(frames); };
      }
      return result;
    };
    navigator.mediaDevices.getUserMedia = constraints => {
      if (!constraints?.video) return original(constraints);
      state.attempts++;
      if (mode === 'denied') return Promise.reject(new DOMException('Synthetic camera permission denial', 'NotAllowedError'));
      if (mode === 'deferred') return new Promise(resolve => { state.release.push(() => resolve(stream())); });
      return Promise.resolve(stream());
    };
  }, { mode });
  return {
    state: () => page.evaluate(() => {
      const state = (window as CameraWindow).__tokaiTestCamera!;
      return { attempts: state.attempts, stops: state.stops, liveTracks: state.tracks.filter(track => track.readyState === 'live').length, tracks: state.tracks.length, pending: state.release.length, workerMessages: state.workerMessages };
    }),
    release: () => page.evaluate(() => { for (const release of (window as CameraWindow).__tokaiTestCamera!.release.splice(0)) release(); }),
  };
}
