# Implementation progress

Full scope: [imp.md](../imp.md). New root: `F:\mili`.

## Delivery agreement

- Work phase by phase.
- At the end of each phase, report what was delivered, checks actually run, limitations, and exact user testing steps.
- Pause for the user's testing/feedback before starting the next phase.
- Push only the work explicitly approved for GitHub. Phase 1 was approved and pushed on 2026-11-03; the user also approved Phase 2 and authorized its push on 2026-11-03. Phase 3 requires its own later approval.

## Phase 1 — foundation and sample lesson

Status: tested and approved by the user on 2026-11-03.

Scope: new pnpm/TypeScript workspace, versioned contracts, usable responsive learning UI, authored sample lessons, local guest/session persistence, editable concept board, transcript, review cards, summary, and provider adapter foundations.

Maps to **parts** of imp.md A01–A07 and early integration fixtures. It does not complete the original entire Wave A: PostgreSQL/Redis/object storage, OIDC, production quota controls, and real credentialed speech probes remain open. File-backed storage is a deliberate local development implementation, not a replacement for the planned persistence layer.

### Delivered

- Initialized the fresh Git/pnpm workspace in `F:\mili` and copied the complete `imp.md` from the original project without changes.
- Built the responsive learning space and four authored sample lessons: photosynthesis, fractions, solar system, and circuits.
- Added guest-owned saved sessions, conversation, concept selection, editable/keyboard-movable board nodes, review cards, lesson completion, Markdown notes, and session deletion.
- Added shared validation, atomic local persistence, board revision conflict detection, and server-side Gemini text / AssemblyAI HTTP speech adapter foundations.
- Fixed question sequencing when help or concept-selection messages interrupt sample practice, and the empty-body request header that prevented lesson deletion.

### Verification completed

- `pnpm typecheck` — passed across all five packages/apps.
- `pnpm test` — 33 tests passed: 3 contracts, 17 speech, 6 tutor, 7 API.
- `pnpm build` — Next.js production build and API TypeScript check passed.
- `pnpm test:e2e` — 2 Chromium walkthroughs passed: desktop lesson/edit/reload/chat/cards/finish/download/delete and mobile lesson/chat/layout.
- Inspected desktop and mobile workspace screenshots after the readability changes.
- Provider tests used mocks; live Gemini and AssemblyAI connectivity, microphone use, and streaming have not been verified.

User handoff: [Phase 1 testing checklist](phase-1-testing.md). Approved snapshot pushed to the private [Avinash1286/mili repository](https://github.com/Avinash1286/mili), branch `main`, commit `a98e6728f5512042883eb1301b42ed48e8ca5227`.

## Phase 2 — live voice loop

Status: tested and approved by the user on 2026-11-03; GitHub push authorized. The user also authorized starting Phase 3.

Scope: authenticated voice WebSocket, live STT and TTS adapters, resampled microphone capture and streaming PCM playback, shared typed/voice conversation, interruption and stale-output rejection, explicit delivery state, bounded resource use, reconnect snapshot, diagnostics, and test/probe tooling. Visual teaching tools and the full beat/board scheduler remain Phase 3.

The user configured both provider keys on 2026-11-03 and requested that the AssemblyAI account stay on the free plan. Direct Gemini remains the tutor provider; no Gateway integration or account/billing changes were made. Credentialed provider probes passed and the user reported that Phase 2 looks good. Phase 2 is a separate approved snapshot from the Phase 1 GitHub push.

### Delivered

- Shared validated control events and binary PCM frames; authenticated, expiring, one-use voice tickets with strict Origin/guest/lesson ownership.
- AssemblyAI streaming STT and TTS adapters with negotiated-format checks, provider deadlines, bounded input, transcript deduplication and cancellation handling.
- Browser AudioWorklets for actual-rate microphone resampling and PCM playback, push to talk, optional hands-free input, microphone selection, output-only mode and text fallback.
- A microphone readiness handshake with a two-second capture buffer; explicit playback acknowledgements and bounded server playback credits.
- Shared typed/voice history, short Gemini teaching turns, selection context, interruption epochs, delayed-output rejection and conservative handling of what was played.
- Stop, disconnect, hidden-page cleanup, permission-denial recovery, fresh-ticket reconnect and authoritative saved-session snapshots without audio replay.
- Delivery labels, timing diagnostics, opt-in real-provider probes and [Phase 2 testing instructions](phase-2-testing.md).

### Verification completed

- `pnpm install --frozen-lockfile` — passed.
- `pnpm typecheck` — passed across all packages/apps and root test/probe tooling.
- `pnpm test` — **103 tests passed**: 7 contracts, 46 speech, 12 AudioWorklet, 9 browser runtime, 10 tutor, 19 API.
- `pnpm build` — production Next.js build and API checks passed after final implementation fixes.
- `pnpm test:e2e` — **5 Chromium walkthroughs passed**: desktop sample lifecycle, mobile sample, typed voice/interruption/reconnect, mobile microphone/deduplicated final, and denied-microphone output-only fallback.
- Desktop and mobile voice screenshots inspected; no horizontal page overflow in the mobile walkthrough.
- Non-live `pnpm verify:speech` and `pnpm verify:tutor` confirmed opt-in behavior without making provider requests.
- Credentialed `pnpm verify:speech --live --streaming` passed with the default `aai-audrey` voice and `universal-3-6-pro` STT: 165,120 PCM bytes, nine best-effort word timings, local cancellation, and a final loopback transcription. The recording is ignored at `var/probes/assemblyai-streaming-probe.wav`. This verifies provider access on the existing account, not audibility, transcript accuracy, or which credit bucket was charged.
- Credentialed tutor verification passed with `gemini-3.5-flash-lite` (validated 179-character reply). The locally configured `gemini-3.8-flash` returned HTTP 503/high demand; the attempted older `gemini-2.5-flash` was unavailable to new users. Only the local `.env` model setting was changed to `gemini-3.5-flash-lite`, which Google's pricing documentation lists with a free tier. No automatic paid fallback or account upgrade was enabled.
- Local startup smoke check passed with the stable API process used by `pnpm dev`; API file watching remains available separately through `pnpm dev:api` after an intermittent Windows watcher startup stall was observed.
- Phase 2 was approved for publishing after the live provider probes and user testing.

The first browser run caught a shared-module import resolution issue and a test-fixture startup issue; both were corrected. A sample save request coincided with a development API restart during implementation; the final run used a stable API and passed. One Windows worker crash cleared when resource-heavy checks were serialized; the complete final test command passed.

### Acceptance and remaining measurement limits

The user accepted the phase after the provider checks and browser testing. The limited live probes verified tutor generation and speech protocol access; objective echo, acoustic interruption delay, network latency percentiles and provider billing/capacity measurements remain **unverified**. Account billing settings were not changed or independently inspected. Fresh TTS connections add handshake cost and consume creation quota; see [provider notes](provider-protocol.md). Distributed persistence/auth and visual teaching tools remain in their planned phases.

## Following phases (start only after the preceding user test)

1. **Phase 2 — live voice loop:** credentialed Gemini and AssemblyAI verification, streaming STT/TTS, browser worklets, interruption, transcript deduplication, measured latency. Complete backend ownership/persistence prerequisites as required.
2. **Phase 3 — teaching and visual coordination:** structured tools, semantic board/tldraw adapter, beat/audio coordination, selection grounding, concept map.
3. **Phase 4 — gestures and spatial lessons:** local MediaPipe, calibration, accessible alternatives, licensed 3D catalog and part selection.
4. **Phase 5 — durable learning:** accounts/PostgreSQL where not already delivered, source upload/retrieval, assessments, mastery evidence, scheduled reviews, summaries/recaps, exports and sharing.
5. **Phase 6 — release and hackathon proof:** real-device/accessibility/security/fault checks, capacity and cost measurements, deployment/restore, provenance, demo and verified submission obligations.

These are reviewable delivery increments across the full imp.md dependency graph. They do not remove planned work. If an increment is too large to review, split it into numbered subphases and stop for testing at each boundary.
