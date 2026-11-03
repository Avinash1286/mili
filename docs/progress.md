# Implementation progress

Full scope: [imp.md](../imp.md). New root: `F:\mili`.

## Delivery agreement

- Work phase by phase.
- At the end of each phase, report what was delivered, checks actually run, limitations, and exact user testing steps.
- On 2026-11-03 the user authorized publishing Phase 3 and completing all remaining phases without pausing for manual acceptance, with a GitHub push after each completed phase.
- Preserve a separate checked commit for each phase. Report remaining live-service, device, deployment and event-verification limits honestly; authorization to continue does not establish those results.

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

Status: tested, approved by the user and pushed on 2026-11-03 at [`80ea6ea`](https://github.com/Avinash1286/mili/commit/80ea6eabc2ca7a47a829a16c1b3837523b960b46). The user also authorized starting Phase 3.

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

## Phase 3 — teaching and visual coordination

Status: implemented, automated checks passed, and pushed to GitHub at `1baa9f4` on 2026-11-03. Live visual-provider verification remains open as detailed below. Phase 2 is pushed to `main` at `80ea6eabc2ca7a47a829a16c1b3837523b960b46`.

Scope: bounded Gemini teaching tools, semantic board transactions and editable diagram templates, independent board/map revisions, student-work protection, selection grounding, explicit board-crop image explanations, linked concept maps, and teaching beats gated by visual readiness and browser playback completion. See [architecture decisions](phase-3-architecture.md). User accounts and distributed persistence, gestures and 3D remain in their planned phases.

### Delivered

- Shared semantic scene and atomic board transactions with stable IDs, independent revisions, bounded commands, operation deduplication and conflict recovery. Tutor updates preserve student-authored shapes, connectors and frames; older saved objects without authorship are conservatively protected as student work.
- A project-owned SVG `BoardAdapter`: editable shapes, equations, fractions, number lines, explicit-point graphs, freehand annotations, connectors and frames; pointer/keyboard editing, pan/zoom/fit, local undo/redo, SVG/PNG export and saved board changes. The renderer choice follows the alternative permitted in `imp.md`; no tldraw license or account upgrade was required.
- Deterministic process, comparison, hierarchy, timeline, labeled-diagram, fraction, number-line, equation and graph templates. Generated content remains editable rather than becoming a flat illustration.
- A bounded Gemini tool loop for diagram creation, typed shape edits, highlights, concept-map updates, lesson focus and short teaching beats. Required drawing/edit inputs are exposed in the provider JSON schemas; all results receive application validation, with at most three model rounds, eight tools, one repair and two beats per turn.
- Semantic selection grounding and an explicit board-crop preview/share flow. Only the share action sends a bounded PNG to Gemini; the image is not stored in the lesson. The preview supports keyboard focus containment, Escape and focus restoration.
- Linked concept maps with stable IDs, graph/list views, saved arrangements, and links to board objects, conversation and review cards. Map changes cannot invent assessment evidence or silently erase student work.
- Durable teaching beats across HTTP and voice: renderer readiness gates speech, and completed browser playback advances the next beat. Cancellation rejects stale output and future uncommitted visuals; committed diagrams remain saved. Captions and delivery states do not claim precise live word timing.
- Isolated browser fixtures for the real application/API/worklets, temporary test storage, and an opt-in metadata-only live teaching probe. Ordinary checks do not call providers or touch user lessons.

### Verification and acceptance

Completed automated checks:

- `pnpm check` — passed: all package/tooling typechecks, **161 unit and integration tests** (25 contracts, 46 speech, 36 web/worklet, 24 tutor, 30 API), the production Next.js build and API build check.
- `pnpm test:e2e` — **12 Chromium walkthroughs passed in the final full run**: desktop/mobile samples, semantic editing/undo/save/grounding/export, two-tab conflict recovery, explicit image sharing, concept-map evidence and arrangement, visual readiness/interruption, successive playback-gated beats, cancelled model results, typed voice/reconnect, microphone deduplication and denied-microphone fallback.
- Desktop and mobile screenshots inspected; the current diagram is framed without covering seed objects, toolbar/export actions remain reachable, and the mobile page has no horizontal overflow.
- `pnpm build` was rerun successfully after the final CSS recovery-banner fix. `pnpm dev` was restarted; the web page returned HTTP 200 and the API liveness check returned `ok` with tutor, speech and voice configuration enabled. These configuration flags do not establish provider availability.
- `pnpm verify:teaching` without flags — passed without making a provider request.
- Local configured key values were checked against all 53 changed/new source and documentation files; zero matches. `.env` and probe recordings remain ignored.

Earlier browser runs exposed a Save board button overlap, a clipped mobile export menu, an error notification covering the Discard action and test selector mismatches; these were corrected before the final passing run. Error messages now occupy their own row instead of covering recovery controls. Validation also drove fixes for order-independent board diffs, connector arrow endpoints, viewport bounds/initial measurement, delayed snapshots, stale PCM, board/map references, legacy opaque IDs, frame diff ordering and diagram placement.

Live Gemini checks exposed an ambiguous drawing-tool schema; diagram creation and explicit edits now have separate required schemas and use documented validated function calling. The bounded probe after that fix returned HTTP **503** before any tool call. Earlier attempts also encountered HTTP 504 and malformed/incomplete tool results. **Live Phase 3 diagram generation has not yet passed**, and live image explanation quality and combined speech/visual timing remain unverified. These are explicit user-testing items, not covered by injected provider fixtures. No further automatic retries, paid fallback or billing changes were enabled.

The direct Gemini plus AssemblyAI architecture and existing free-account preference remain in effect. Live requests consume the configured accounts' quota/credits; account billing settings have not been independently inspected. User handoff: [Phase 3 testing checklist](phase-3-testing.md). The user authorized continuing through Phases 4–6 and pushing each completed phase without waiting for separate manual testing.

## Phase 4 — gestures and spatial lessons

Status: implemented, checked locally and pushed at `7ffa8a1`. Physical hand-recognition and combined real-device audio/graphics measurements remain unverified.

### Delivered

- Optional local MediaPipe tracking, self-hosted pinned assets, compatible ES-module WASM worker, throttled fallback, camera denial/late-permission/loading-cancellation recovery, hidden-page cleanup and inference deadlines.
- Mirroring, hand preference, two-corner calibration, smoothing/dead zones, deliberate draw/pan/pinch/zoom/rotation, ambiguous-circle confirmation and opt-in palm help with dwell/cooldown. Help prepares a question for the learner to send; it never infers emotion or understanding. Pointer, keyboard and text alternatives remain available.
- Four original procedural GLBs: solar system, DNA, chloroplast and a schematic heart. Catalog manifests include semantic parts, sources, scale limitations, geometry budgets, checksums, MIT asset attribution and labeled 2D/text alternatives. Controls include orbit, zoom, camera presets, labels, selection, isolation and animation, with resource disposal.
- Bounded catalog-only tutor tools and trusted part grounding, durable teaching beats, readiness/playback gates, saved model/surface state, model-to-board transitions and preservation of manual selections for text-only answers.
- Reproducible asset sync/check scripts and [Phase 4 testing instructions](phase-4-testing.md). External hand-model weights are downloaded locally and excluded from Git; source and checksum remain tracked. Inspected sources did not establish an explicit redistribution license for that exact bundle.

### Verification completed

- `pnpm typecheck` passed across applications, packages, scripts and browser fixtures.
- `pnpm test`: **198 passed** — 28 contracts, 46 speech, 58 browser/worklet/gesture/spatial, 30 tutor and 36 API.
- `pnpm build`: production Next.js build and API build check passed.
- `pnpm test:e2e`: **21 Chromium scenarios passed** in the final full run. The additional manual-selection regression passed in a focused rerun after its fix. Coverage includes the prior twelve scenarios, camera lifecycle/inference, all four actual GLBs, keyboard manipulation, fallback, grounding/reload, board transitions and readiness/interruption.
- The actual MediaPipe worker/WASM/model initialized and produced at least three inference results on synthetic blank camera frames. Disable stopped the live track, and no external requests were observed during that short test window. This establishes startup/inference plumbing and cleanup, not recognition accuracy or every SDK behavior over a long session.
- `pnpm assets:check`: all nine local assets matched pinned hashes and byte counts. The external task model remains ignored by Git.
- Desktop/mobile screenshots inspected; the mobile walkthrough confirmed no horizontal overflow. A later focused screenshot correctly retained the manually selected DNA part.

Checks exposed and corrected a Windows Vitest glob issue, incompatible worker WASM loader, stale-label crash while switching models, hidden-board transitions and text-only selection resets. Live Gemini model-tool quality, physical camera calibration/recognition, low light/occlusion, Safari/iOS, screen readers and combined speech/gesture/3D performance remain device-validation items. No live provider requests or account upgrades were made for these checks.

## Current delivery scope

The user authorized completing all remaining phases and pushing each checked phase without another approval. Their latest infrastructure choices are **Convex for persistence and durable AI jobs**, followed by **Vercel for the website after local completion**, with **no GitHub Actions**. The persistent Fastify voice/API process needs a compatible backend destination; frontend hosting alone does not supply it. Demo videos and hackathon submission work remain deferred. No account billing upgrades or paid provider fallbacks are authorized.

## Phase 5 — durable learning

Status: implemented and checked locally; publishing authorized. The Convex service boundary, transactional owner-scoped records and private files, durable scheduled jobs with fence checks, native local Convex and OIDC services, source ingestion, authored/generated assessments, evidence-based progress, cards/review scheduling, study packs, exports, sharing and product screens are functional. Deployment hardening and public hosting remain Phase 6 work.

- Native local Convex runs without Docker or a cloud account. Persistence, concurrent rollback, private storage and 384-dimensional owner-filtered retrieval have passed scoped integration tests.
- Six existing Phase 1–4 lessons and ten guest/auth records were imported idempotently with timestamped local backups. Original files remain unchanged; normalized snapshots match the originals.
- Local English OCR and pinned CPU embeddings passed an actual image-to-text-to-vector probe. The real Convex scheduled-action journey then uploaded a three-page PDF containing text and a scanned page, extracted three indexed chunks, retrieved the scanned page with a 384-dimensional query, denied a different owner, and deleted the isolated probe owner/files successfully.
- Learning engine, generated-content schema adapters and durable artifact tests cover grading uncertainty, assistance, idempotency, stale leases, deletion races, caption timing, transcript retention and Unicode PDF extraction.
- Browser scenarios exercise preferences/history, numeric/diagram practice, hints/retries/appeals, study packs/export/sharing, card review, responsive controls and dictation cleanup. The integrated run passed 27 of 29 cases and exposed two UI races: a failed health read disabled voice indefinitely, and delayed preferences overwrote a typed goal. Both were fixed. All eight product scenarios plus camera denial passed the focused rerun, and both added race regressions passed their final run. Across these runs all 31 current Chromium scenarios passed; this is not a claim of one final 31-case run.
- Actual local Keycloak/OIDC sign-in and guest claim passed its integration test. Eight real local Convex integration cases passed in addition to the isolated-file unit tests; the Convex restart retained imported snapshots.
- A real Gemini structured-teaching request passed with one model call, four board commands and one teaching beat in 36,954 ms. This resolves the earlier Phase 3 provider-functionality blocker while leaving conversational latency and human/device quality validation open. See [provider evidence](phase-5-provider-check.md).
- Final review corrected immediate transcript/recap revocation, cookie-token upload leakage, source-only sample leakage, spoken-recall regeneration, stale appeal exports/shares, and preference propagation through the home-page shortcut. The PDF export was rasterized and visually inspected with embedded Unicode font coverage.

### Final engineering checks

- `pnpm typecheck` passed for all workspaces, root tooling and Convex functions.
- `pnpm test` passed **308 tests**: contracts 28, speech 47, web/worklet 67, database 10, learning 33, tutor 49, grounding 4 and API 70. Nine external-service cases are opt-in in this command; all eight actual Convex cases and the actual OIDC case passed separately as described above.
- `pnpm build` passed after the final integration fixes. Desktop/mobile product screenshots and the rendered PDF were inspected.
- `pnpm check:secrets --staged` scanned 169 changed/new files against seven configured credential values and private-key markers: zero findings. No GitHub Actions files were added.

The free-account preference remains unchanged. Live model latency, spoken teaching quality, subject-matter review by independent people, physical camera/microphone behavior and Safari/iOS/screen-reader checks remain explicit validation limits. Automated synthetic audio, injected provider fixtures and deterministic grading tests do not establish human learning outcomes or real speech recognition accuracy. Source OCR currently supports English. See [testing guidance](phase-5-testing.md), [local architecture](phase-5-architecture.md) and [live provider evidence](phase-5-provider-check.md).

## Phase 6 — release readiness (pending)

Complete accessibility/security/fault checks, bounded capacity/resource measurements, actual provider verification, local restore/operating documentation and the final end-to-end journey. Then deploy the website through Vercel and verify its real backend connection. Physical-device and human curriculum validation cannot be inferred from automated fixtures.
