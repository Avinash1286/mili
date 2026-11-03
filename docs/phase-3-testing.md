# Phase 3 — teaching and visual coordination

This checklist covers the semantic whiteboard, structured teaching tools, concept map, explicit drawing sharing, and coordination between teaching steps and speech. Use [progress.md](progress.md) for the checks actually completed and remaining limitations. Phase 2 was approved and pushed; Phase 3 requires its own user test and separate push approval.

## Start locally

From `F:\mili`, run `pnpm dev` and open [localhost:3000](http://localhost:3000). Keep the existing local Gemini and AssemblyAI configuration. This phase does not require LLM Gateway, an AssemblyAI plan upgrade, or a new billing account.

Choose **Guided sample** for authored content and manual board tools without model requests. Choose **Live AI** for generated teaching and explicit image explanations. Live actions use the configured accounts' existing quota or credits. Provider configuration does not establish credit eligibility, and no test result verifies billing settings.

## Whiteboard and saved work

1. Open a lesson. Select a shape, choose **Edit …**, change its **Label** or **Your note**, then **Apply edit** and **Save board**. Reload and verify the change remains.
2. Choose **Add shape**. Try a rectangle, equation, fraction, number line or graph. Fraction inputs describe equal parts within one whole. Equations are editable text; they are not evaluated or executed. Graphs use explicit numeric points rather than executable expressions.
3. Move a selected shape with the arrow keys or drag it. Try **Draw tool**, **Pan tool**, **Erase tool**, **Undo**, **Redo**, zoom and **Fit frame**. Save after editing. Undo history belongs to the current browser view; reloading restores saved content, not that local history.
4. Use **Connect ideas**, **Insert diagram template**, and **New frame**. Change the **Frame** selector to revisit a page. Confirm labels, relationships and diagram shapes remain individually editable.
5. Open **Board export and reset** and download SVG or PNG. Reset asks for confirmation and can be undone in the current view. Verify the exported content rather than assuming a successful download proves the diagram is correct.
6. Open the same saved lesson in two tabs. Make an unsaved change in the first tab, then save a different edit in the second. Saving the older draft should show a conflict and preserve it. **Discard** deliberately loads the saved version; copy any local note you want to keep before discarding.

## Live teaching and selection

1. In a **Live AI** lesson, ask: “Draw a small process diagram showing sunlight providing energy to make sugar. Explain one step at a time.” Accepted visual actions should create editable objects and readable narration. Invalid actions should produce a useful warning or text fallback, preserving existing work.
2. Select an object and choose **Explain selected idea**, then send the prepared question; alternatively type “What does this do?” Check that the explanation refers to the selected label and meaning. Select multiple objects and ask an ambiguous question; the tutor should request clarification when it cannot resolve one target.
3. Make and save your own annotation or note, then ask for another diagram. Tutor changes must preserve student-authored objects. During a voice session, moving or editing an object while the tutor is preparing a visual must not let the older result silently overwrite that edit. Typed HTTP requests temporarily lock editing while their response is pending.
4. Watch the **Concepts** view as accepted map tools add relationships. Use its graph and accessible list, select a linked concept, and check its associated board object or learning material. Reposition a map node, save its position, reload, and confirm the layout remains. Mentioning a concept must not mark it understood.

## Voice and visual timing

1. Choose **Start without microphone** and send the diagram question. The corresponding visual should be rendered before its spoken step begins. Later steps should wait for the previous step's playback to complete.
2. Click **Stop tutor** during the first step. Sound should stop promptly. The first committed diagram remains; later uncommitted teaching steps, stale highlights and queued audio must not continue.
3. Ask a new question immediately. Only the new answer should continue. Reload or reconnect and confirm saved objects remain while old audio stays silent.
4. Try editing and saving during a voice session. A version conflict should preserve the local edit and show a clear recovery path. Student changes and tutor batches must not silently replace each other.
5. Test the microphone and push-to-talk controls again using the [Phase 2 checklist](phase-2-testing.md). Automated synthetic audio cannot establish speaker echo behavior, speech accuracy, or acoustic interruption latency on your device.

Each teaching step is short, and a response has at most two steps. The current speech adapter opens a fresh synthesis connection for each request; rapid repeated turns can reach provider session-creation limits. A rate-limit response is not permission to upgrade the account. This phase coordinates beats and board highlights; it does not provide live word-by-word read-along. Provider word boundaries arrive after synthesis delivery. Do not assume that generated text was heard.

The cancellation boundary is the server's durable visual commit. A diagram committed before the server receives **Stop tutor** remains in the saved board and may appear in a later authoritative snapshot, even if the browser had not rendered it or played its narration yet. Stop cancels future uncommitted steps and audio; it does not roll back already committed board content or student annotations.

## Explicitly share a drawing

1. In a live lesson, save your drawing and select it. Choose **Preview drawing to share**.
2. Inspect the preview. Opening or cancelling this dialog must not send an image to the tutor. The image is a board crop, not a continuous camera or screen feed.
3. Enter **Your question** and choose **Share drawing with tutor**. Only this explicit action sends the preview to the configured Gemini model. The crop is bounded to PNG, at most 1024 × 1024 pixels and 1 MB decoded. Sharing stops any active voice connection; start voice again afterward if needed.
4. Check whether the explanation matches the visible drawing. Unclear handwriting should lead to clarification, not invented certainty. The session records the explanation and a sharing note; the crop is not added to saved session history.

## Accessibility and mobile

At a phone-sized width, test **Whiteboard** and **Study tools**, keyboard selection and movement, the accessible board description, and the concept-map list. Confirm there is no horizontal page overflow, controls remain reachable, and typed interaction works without microphone or camera access. The board may have its own pan/zoom interaction without widening the whole page.

## Automated checks and optional probe

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm verify:teaching
```

Browser tests use the real application, API orchestration, persistence, and AudioWorklets with explicitly injected tutor, vision, HTTP speech, STT and TTS fixtures. Requests are routed to temporary test storage. They do not use the local provider keys or modify the user's saved lessons.

Running `pnpm verify:teaching` without flags makes no provider request. To explicitly spend one model request:

```powershell
pnpm verify:teaching --live
```

The probe defaults to one Gemini model call with no repair or follow-up call, applies validation to a temporary lesson, and makes no speech request or saved-session change. A pass requires accepted drawing and teaching tools with actual visual commands; text fallback does not count. The command reports only metadata, including incomplete tool results. It does not evaluate teaching accuracy, browser rendering, account billing, or live audio timing.

The provider contract uses `draw_shapes` with a required diagram, `edit_shapes` with required typed commands, and `submit_teaching_beat` for narration. The probe specifically checks diagram creation plus narration; arbitrary rendering code is never accepted.

Some models wait for the drawing tool result before submitting narration. To explicitly permit up to two model calls with no repair attempts, use `pnpm verify:teaching --live --rounds=2`. This optional flag can consume a second request; it is never enabled automatically.

## Remaining product scope

Gesture recognition, 3D scenes, accounts and production persistence, uploaded-source retrieval, full assessment/mastery evidence, scheduled review, and deployment remain in later phases of [imp.md](../imp.md). Current semantic diagrams and learning labels are not a substitute for source or subject review.

Report the browser/device, the steps, and whether a problem affects saved edits, selection, maps, drawing sharing, or speech. Do not include API keys. Stop after this phase for testing feedback; publishing Phase 3 requires separate approval.
