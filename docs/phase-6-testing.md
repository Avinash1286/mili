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

Leave voice connected long enough to exercise planned connection rotation. It should reconnect with the current saved lesson and never replay old audio. Hide the page or disconnect and check that capture stops. Camera sharing remains separate: hand tracking is local, while a board image is sent only after its explicit preview/share action.

The automated checks exercise browser PCM plumbing, synthetic interruption, provider adapters, cancellation, durable ownership, rendering, assessments and recovery. They cannot establish real microphone accuracy, echo behavior, physical hand-recognition accuracy, spoken teaching quality, Safari/iOS compatibility, screen-reader usability or learning gains. Record these separately when testing on actual devices.

## Repeatable engineering checks

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm eval:tutor --report
pnpm verify:capacity
pnpm verify:restore
```

Run browser runners sequentially after a production build; do not rebuild `.next` underneath a running test server:

```powershell
$env:TOKAI_E2E_PRODUCTION='1'
pnpm exec playwright test --config tests/phase6/playwright.config.ts --workers=1
```

Use the native integration flag documented in the test file for the separate real-account/private-transfer check. Ordinary fixture tests do not call providers. The actual restore probe runs on independent ports3212/3213 and leaves the main backend unchanged. Detailed evidence and exact final counts belong in [progress](progress.md), [accessibility](phase-6-accessibility-audit.md), [operations](phase-6-operations.md) and [usage measurements](phase-6-usage.md).
