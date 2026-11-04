# Phase 4 — gestures and spatial lessons

Use this checklist to exercise local camera gestures and the catalog of educational 3D scenes. [Progress](progress.md) records which checks actually ran. Browser fixtures verify application behavior; they do not establish real hand recognition, anatomical accuracy, provider quality, or device performance.

## Start and privacy

Run `pnpm dev` from `F:\mili` and open [milli](http://localhost:3000). Start a **Guided sample** to explore manual controls without a tutor request. **Live AI** actions use the configured Gemini and AssemblyAI accounts. No account upgrade or LLM Gateway setup is needed.

The camera should start only after an explicit enable action. Gesture processing stays in the browser. A gesture sends its semantic action or selection to the application, not a continuous video feed. The separate **Preview drawing to share** flow still requires explicit sharing of a board crop; enabling gestures is not consent to share camera images.

## Camera lifecycle and intentional gestures

1. Choose **Enable camera gestures**, then deny camera access. The interface should explain the failure and keep keyboard, pointer, text and voice controls usable.
2. Enable the camera and open **Gesture settings and camera preview**. Check **Mirror camera** and **Hand preference**. Choose **Calibrate pointer**, point at a comfortable top-left corner and capture it, then repeat for the bottom-right corner. Repeat after resizing the browser and changing board zoom or pan.
3. Try **Point**, **Draw**, **Pan** and **Zoom** in **Gesture mode**; use **Rotate** in the spatial viewer. Point moves the cursor and pinch selects. Draw uses the index finger; pan/rotation uses a closed fist. Check that the displayed pointer, recognized gesture and intended target agree before committing an action.
4. Turn on **Enable palm help**, select a target, and hold an open palm for 1.2 seconds. It should prepare one help question; review it and press **Send question**. Holding the pose must not repeatedly prepare questions, and another help action has an eight-second cooldown. **Ask about selection** provides the explicit button equivalent. Confirm ambiguous targets rather than accepting an arbitrary nearby object.
5. Disable gestures while initialization is pending, then after the camera becomes active. The camera indicator should switch off and processing should stop. Leaving the lesson or hiding the page should also release its camera tracks.
6. Retry after denial, unplugging the camera, or a model-load failure. A failed or cancelled initialization must not later reopen the camera or emit stale actions.
7. Repeat the corresponding actions with keyboard and pointer controls while the camera is disabled. Do not require gestures for any learning task.

Use the supported controls actually shown by the application; a recognized pose is not evidence of the learner's emotional state or understanding.

## Spatial catalog and accessible controls

1. Choose **3D models** and use **Model** to open the solar-system, DNA, chloroplast and heart entries. Check each description, attribution, illustration/scale limitations and semantic part list. The chloroplast is a schematic organelle cutaway, not an entire plant cell; the heart is an educational schematic, not a medical reference.
2. Select a labeled part using both the viewer and its accessible list. Confirm that the same part is highlighted and described. Try Earth, a DNA base pair, chloroplast structures and a heart chamber.
3. Exercise orbit, zoom, camera presets, reset, label visibility and part isolation. Use the keyboard controls as well as pointer/touch interaction. Reset should restore a useful overview without losing the selected lesson.
4. Switch models repeatedly. Old selection and isolation must not refer to parts of the previous model. Closing the viewer should release animation loops and graphics resources.
5. Exercise the labeled diagram/text fallback. Part descriptions and learning controls must remain usable when WebGL is unavailable or the renderer fails. An unsupported topic should lead to an explanation or diagram, not an empty viewer.
6. Reload the lesson and confirm the saved model/part selection is restored when it was committed. Browser camera/orbit state must not be mistaken for a saved learning outcome.

## Tutor grounding and cancellation

In **Live AI**, ask “Show DNA and highlight a base pair.” Check that the chosen catalog model and semantic part agree with the explanation. Then select a different part and ask what it does. The tutor should receive the explicit model/version/part identity and use the catalog's description; an invalid part or unsupported model must not silently become a guessed selection.

Start speech output and request a spatial explanation. The corresponding model selection should be ready before its spoken step starts. Stop during the first step, then ask a new question. Queued audio and future uncommitted spatial changes from the old response must stop. As with the whiteboard, an already committed visual may remain in the saved lesson; interruption does not roll back committed work.

## Real-device record

Automated camera fixtures contain synthetic pixels/landmarks. Record these checks on actual hardware before calling gesture recognition validated:

| Check | Record |
|---|---|
| Device and browser | OS, browser/version, camera, microphone, viewport |
| Calibration | Mirrored/unmirrored mapping, board zoom/pan, resize |
| Hands and visibility | Left/right hand, multiple hands, occlusion, low light |
| Intent | Dwell, false activation, release/cooldown, ambiguous selection |
| Combined workload | Audio underruns and responsiveness with gestures and 3D active |
| Recovery | Permission denial, unplug, hidden tab, disable during loading |
| Mobile/accessibility | Touch, keyboard-only, screen reader, reduced motion, camera off |

Do not infer Safari/iOS camera or autoplay behavior from Chromium desktop emulation. A screenshot of a canvas does not prove the model is accurate or that graphics resources were released.

## Automated checks

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Ordinary tests use temporary API storage and injected tutor/speech providers. Camera tests replace browser capture with a synthetic stream and explicitly observe track cleanup. One browser scenario loads the actual local MediaPipe worker, WASM and gesture model without intercepting those assets; it requires three real inference results on blank frames and verifies shutdown, not recognition accuracy. Its `mediapipe-initialization.json` attachment records bounded asset paths/statuses, request origins/paths, worker result counts, error messages and track state for diagnosis. It rejects external requests observed during that short startup/inference window; this is not a claim about every possible SDK behavior over a long session. No camera pixels or hand coordinates enter that diagnostic attachment. Pure gesture tests use known landmarks and board transforms. Spatial fixtures use catalog IDs and production validation. These tests make no paid provider requests and do not use a physical webcam.

Report the exact control/action, model or gesture mode, browser/device, and whether the issue affects saved content, media cleanup, selection, or speech. Do not include credentials or private camera recordings.
