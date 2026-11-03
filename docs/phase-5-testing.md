# Phase 5: learning that lasts

Use the local startup instructions in `docs/phase-5-architecture.md`. The web application uses the persistent Fastify API; Convex stores production learning data and job state. Automated browser fixtures use isolated file storage and simulated providers, while exercising the same API, ownership checks, grading engine and leased artifact executor. They do not establish live model quality or real speech recognition accuracy.

## Walk through the product

1. Open `/settings`. Set a display name, timezone, learning preferences and privacy defaults for new lessons. Save, reload, and check the values. Existing lessons retain the privacy settings copied at creation; changing account defaults does not rewrite them. Reduced motion, higher contrast and larger text apply throughout the workspace. Sign-in is available only when the local identity service is configured; guest learning remains tied to its browser token.
2. Open `/learn/new`. Choose a prepared sample, or enter a custom live topic with a learning goal, level, length, language and voice. Prepared samples are English authored content; their wording does not adapt to learner preferences. Live lessons require configured providers. Device checks are optional and stop the camera or microphone immediately after checking access.
3. Open `/library`. Upload a PDF, PNG, JPEG or text file up to 10 MB. Wait for `ready` before selecting it in a new live lesson. Failed processing has an explicit retry; deletion removes its indexed source. Source-only lessons must have a selected ready source and should explain when support is missing. Local OCR/embedding startup is separate from the provider-mocked browser checks.
4. Resume a lesson from `/dashboard` or `/library`. Search by title, topic or saved notes; rename, archive and restore it. The saved lesson page is `/sessions/<id>`.
5. In **Practice**, start a question and submit a choice, number/unit, explanation or diagram labels. Hint and answer-reveal use is recorded. Correctness, reasoning and feedback confidence are separate. Retries retain their earlier-attempt link; revealing an answer cannot be erased by starting another presentation. Appealing a result withdraws its disputed mastery evidence rather than inventing an improved grade.
6. In **My notes**, save a private note. If the lesson changes in another tab, saving shows a conflict and keeps the local draft. **Reload saved notes** replaces it only after confirmation.
7. In **Study pack**, request materials and follow their queued/running/ready/failed states. A completed pack separates completed narration, interrupted segments, reference concepts, practice evidence and unresolved questions. Request Markdown, PDF, JSON or card CSV exports. Enable **Allow saved recap audio for this lesson** before generating a recap. This consent persists across reloads; disabling it removes existing saved recap audio. Recap generation also needs eligible narration. The audio player has speed controls and provider-aligned captions.
8. In **Review cards**, edit a card, including explicit before/answer/after fields for cloze cards. Content changes reset its review schedule. Discard or mark incorrect material for correction; regenerate from its source where supported. Merge only identical duplicates. In `/review`, recall first, compare, and explicitly choose Again/Hard/Good/Easy. Suggestions can be overridden. Review scheduling does not itself establish assessed mastery.
9. In **Share**, generate a read-only link with a 1–30 day expiry. Notes and cards are excluded by default. Preview the shared pack and revoke the link; reloading a revoked link must deny access. Sharing is an explicit action, never automatic.

## Speech and privacy checks

**Dictate answer** records at most 30 seconds locally. **Stop and transcribe** stops physical microphone tracks before sending bounded PCM for transcription. Check the inserted text before submitting the answer. **Cancel dictation**, navigation and unmount discard unfinished capture and stop its tracks. The application does not use browser speech recognition.

Test microphone denial, late permission, cancellation while transcribing and navigation during capture on a physical device. The browser fixture uses a synthetic oscillator and simulated STT, so it establishes capture/transport/cleanup behavior rather than the accuracy of a spoken answer. Real device permissions, acoustic feedback, Safari/iOS and screen-reader behavior still require device testing.

Shared pages are read-only and fetch public share data without owner credentials. A different guest must not be able to open a private lesson, source, assessment, artifact or card by guessing its identifier. Account sign-in should claim the current guest learning and use an HttpOnly cookie; old guest credentials are cleared after account identity is confirmed.

## Automated checks

- `pnpm --filter @tokai/web typecheck`
- `pnpm --filter @tokai/web exec vitest run tests/product-api.test.ts`
- `pnpm exec playwright test tests/e2e/product-learning.spec.ts --workers=1`
- `pnpm test:e2e` for regressions in the earlier voice, board, gesture and spatial flows.
- The repository-wide typecheck, tests and production build remain required before release. See `docs/progress.md` for the final verification counts and any outstanding limitations.

The product browser scenarios cover preferences/history, private notes and conflicts, numeric/diagram practice, assistance/retry/appeal, real artifact jobs and Markdown download, default share privacy and revocation, cloze editing, review receipt advancement, mobile overflow/device denial, worklet dictation cleanup, and custom live-topic routing with injected provider responses. Generated screenshots are written under ignored `test-results/` paths. No paid calls are made by these fixtures.
