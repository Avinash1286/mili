# Final application walkthrough

Use the local application at `http://localhost:3000` with the native Convex backend and API running. The public Vercel address will be recorded in the deployment runbook only after it passes the hosted checks. Keep provider keys in ignored environment settings.

## Saved learning without provider requests

1. Open a prepared sample and confirm the sample disclosure is visible. Ask a typed follow-up, edit a board object, use undo/redo and save. Reload the lesson and check the saved result.
2. Move among Conversation, Concepts, Cards and Practice using keyboard arrows/Home/End. Follow a concept to its board object. Try the model surface and its labeled text/2D alternative. Camera and microphone access are optional.
3. Start practice, answer, request a hint, then retry. Feedback must distinguish assisted work from an unaided result. Appeal a result and confirm its mastery evidence is withdrawn. A duplicate submit must not add another attempt.
4. End the lesson, open its saved materials, download Markdown/PDF/cards/board exports, create a share link and revoke it. The revoked link must stop working. Resume the saved lesson from the dashboard.
5. Review a due card, rate recall, reload and confirm scheduling is preserved. Edit or flag an incorrect card. Change preferences and check that a new lesson uses them.
6. In Settings, refresh the daily allowance. It describes application limits, not a provider credit balance. Clearing transcript/audio retention must remove access to the corresponding saved materials. Delete a throwaway lesson and verify that another browser cannot read it by URL.

## Accounts and uploaded material

Create a throwaway account through the configured sign-in path, explicitly claim the current guest workspace, sign out and sign in again. Its lessons should persist and belong to that account. Account deletion removes application access and queues native credential cleanup. Password recovery/email verification are not configured in native local signup; the interface discloses this instead of showing a fake reset action. OIDC remains available when configured.

Upload a small text document or a PDF with a scanned English page, wait for the actual background job to finish, and check its source status. A source-only live lesson requires a ready source and configured Gemini. Ask about the uploaded passage and inspect its citation/page. Unsupported source-only questions must not acquire unrelated prepared-reference claims. Use a separate browser profile to verify that private files and lessons are inaccessible to another learner.

## Real voice and tutor checks

These consume the existing provider account quota. Start a Live AI lesson, listen to a response, ask a microphone question, interrupt, and use typed input when microphone access is denied. Inspect the editable diagram and the transcript. Ask for a stored practice question, open its practice control, submit an answer and confirm the original question/assistance history is retained. Ordinary conversation must not silently become graded evidence.

Scheduled auto-rotation is **disabled by default in the local API**. Waiting in an ordinary local lesson does not test that feature. The Vercel runtime defaults to rotation after four minutes, with up to 30 seconds of grace for active work; the dedicated soak explicitly uses a shorter 12-second rotation. On a rotation-enabled runtime, confirm that the browser reconnects with the saved lesson and never replays old audio. Hide the page or disconnect and check that capture stops. Camera sharing remains separate: hand tracking is local, while a board image is sent only after its explicit preview/share action.

The automated checks exercise browser PCM plumbing, synthetic interruption, provider adapters, cancellation, durable ownership, rendering, assessments and recovery. They cannot establish real microphone accuracy, echo behavior, physical hand-recognition accuracy, spoken teaching quality, Safari/iOS compatibility, screen-reader usability or learning gains. Record these separately when testing on actual devices.

## Repeatable engineering checks

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm eval:tutor --report
pnpm verify:capacity
pnpm verify:restore
pnpm exec node --expose-gc --import tsx scripts/verify-voice-soak.ts
```

Run browser runners sequentially after a production build; do not rebuild `.next` underneath a running test server:

```powershell
$env:TOKAI_E2E_PRODUCTION='1'
pnpm exec playwright test --config tests/phase6/playwright.config.ts --workers=1
pnpm exec playwright test --config tests/phase6/regression.config.ts --workers=1
```

Set `TOKAI_E2E_NATIVE=1` explicitly to include the actual local real-account/private-transfer check; it is skipped by default. The normal Phase 6 suite now contains 28 fixture cases plus that one opt-in case. Ordinary fixture tests do not call providers. The actual restore probe runs on independent ports3212/3213 and leaves the main backend unchanged. The three-minute voice soak creates fresh native data and keys on ports3214/3215, uses synthetic providers, and stops its own backend afterward. Detailed evidence and exact final counts belong in [progress](progress.md), [accessibility](phase-6-accessibility-audit.md), [operations](phase-6-operations.md), [usage measurements](phase-6-usage.md) and the [voice soak](phase-6-voice-soak.md).


## Browser evidence recorded on 4 November 2026

- The complete production Phase 6 run passed **25/25** cases in 2.7 minutes, including real native signup, guest claim, logout/login, direct Convex upload/download, CPU ingestion and deletion of its own test account.
- The complete existing production regression run passed **31/31** cases in 4.4 minutes, including local MediaPipe initialization on synthetic media, the four actual GLB assets, device denial/cleanup, editing, artifacts and interruption.
- After the final named-group, student-label and native proxy changes, the affected-state run passed **7/7** in 1.2 minutes. It adds the new saved-recap case and repeats six earlier cases; do not add the run counts as if all were distinct. The recap uses a synthetic provider and verifies captions, decoded audio and playback speed.
- The three additional resource-control cases passed **3/3** in 2.1 minutes against the rebuilt production UI: source expiry while the page remains open, recap removal at its deadline without another learning fetch, and six allowance categories with explicit synthetic dollar commitments at 320 px. These checks bring the suite to 29 distinct cases; there was no single 29-case rerun. All three axe scans had zero violations; six recap contrast nodes remain manual-review items.
- Final affected-state axe scans report no violations or unsupported-ARIA incomplete findings. SVG/background and short-text contrast items still require manual review. The actual native integration observed zero enforcing-CSP violations after the final proxy change.

The 320 px large-text Workspace case completes a numeric practice submission and checks that all four study tabs fit the viewport; it does not establish usability on every physical mobile device. Real screen-reader, physical camera, real speech, echo, Safari/iOS and human-learning checks remain manual. See the [accessibility audit](phase-6-accessibility-audit.md) for exact artifacts, run boundaries and the prepared protected-preview command. No hosted result is implied by these local checks.
