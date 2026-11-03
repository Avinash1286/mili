// Pinned, self-hosted MediaPipe module; frames remain in this worker.
import { FilesetResolver, GestureRecognizer } from '/vendor/mediapipe/vision_bundle.mjs';
let recognizer;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const vision = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm', true);
      recognizer = await GestureRecognizer.createFromOptions(vision, { baseOptions: { modelAssetPath: '/vendor/mediapipe/gesture_recognizer.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .65, minHandPresenceConfidence: .65, minTrackingConfidence: .65 });
      self.postMessage({ type: 'ready' });
    } catch { self.postMessage({ type: 'error', message: 'Hand tracking could not start.' }); }
  } else if (data.type === 'frame') {
    const started = performance.now();
    try {
      const result = recognizer.recognizeForVideo(data.bitmap, data.timestamp);
      self.postMessage({ type: 'result', hands: result.landmarks.map((landmarks, i) => ({ landmarks: landmarks.map(({x,y}) => ({x,y})), gesture: result.gestures[i]?.[0]?.categoryName || 'None', confidence: result.gestures[i]?.[0]?.score ?? 0, handedness: result.handedness[i]?.[0]?.categoryName || '' })), elapsedMs: performance.now() - started });
    } catch { self.postMessage({ type: 'error', message: 'Hand tracking stopped. Use the board controls or try again.' }); }
    finally { data.bitmap.close(); }
  } else if (data.type === 'close') { recognizer?.close(); self.close(); }
};
