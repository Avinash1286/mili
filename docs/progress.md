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

The user authorized completing all remaining phases and pushing each checked phase without another approval. Their latest infrastructure choices are **Convex for persistence and durable AI jobs**, followed by **Vercel for the website after local completion**, with **no GitHub Actions**. The selected deployment uses separate Next.js and Fastify Vercel Services with bounded WebSocket rotation; actual hosted runtime checks remain required. Demo videos and hackathon submission work remain deferred. No account billing upgrades or paid provider fallbacks are authorized.

## Phase 5 — durable learning

Status: implemented, checked locally and pushed at `0ff8386`. The Convex service boundary, transactional owner-scoped records and private files, durable scheduled jobs with fence checks, native local Convex and OIDC services, source ingestion, authored/generated assessments, evidence-based progress, cards/review scheduling, study packs, exports, sharing and product screens are functional. Deployment hardening and public hosting remain Phase 6 work.

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

## Phase 6 — release readiness (in verification)

Implementation now includes durable one-use voice tickets and bounded connection rotation, private direct Convex transfers, native Convex-backed password accounts alongside OIDC, owner/global generation admission, actual provider metadata and optional dated estimates, tutor-to-practice transactions, HTTP cancellation, production security headers and job recovery. Final browser, dependency and hosted checks are still running; no public deployment is claimed.

Verified so far on November4 (Nepal time):

- The latest complete workspace unit/integration command passed **355 tests**, with17 external-service cases skipped by default. Additional focused checks passed after later changes; the final combined check is pending the remaining release controls. Real local Convex quota admission/pricing passed separately, including independent API clients, shared limits, duplicate settlement and owned session totals.
- Actual native backup/restore matched602 records across29 tables including12 authentication component tables. A separate native file was exported, physically deleted and restored with identical bytes. Nine job recovery and seven retention assertions passed against an isolated backend; the main database was read-only during that probe.
- Four learners completed60 prepared turns through real HTTP/Convex, with72 successful requests, cross-owner denial and p95 latency613ms. This is a local sample capacity result, not live-provider throughput.
- Full workspace typechecking passed, including deployment/local tooling and Convex. Production Next builds passed; the final combined build will run after the remaining release controls. All25 Phase6 production-browser checks passed together, followed by all31 existing regression scenarios. The final focused seven-case run passed after the last contrast and native proxy fixes; it includes the new recap-player audit, bringing distinct Phase6 cases to26. The actual account/guest-claim/upload/CPU-ingestion/download/deletion journey passed with zero CSP violations.
- The offline learning corpus passed64/64 deterministic invariant cases without provider requests. Native account signup/login/revocation/deletion and private6MiB transfer checks passed; real browser integration remains a separate gate.

The final scope audit identified three engineering items from the original plan requiring explicit completion: generated OpenAPI, storage/egress metering with configurable monetary admission, and sustained voice disconnect/memory testing. The OpenAPI generator now covers actual registered HTTP routes and shared request contracts; generation, drift checking,28 contract tests and13 focused HTTP tests passed. The remaining two items are being implemented and checked before the final phase commit.

Testing found and corrected premature HTTP creation acknowledgements, board/map publication before commit, a schema import cycle, guest-claim cancellation and usage-transfer ordering, narrow-screen tab clipping, contrast/semantic issues, strict-CSP upload origin mismatch and Zod's optional dynamic-code probe. Background work now cancels when its executor disconnects and gives busy capacity time to clear before bounded retries. A real two-API Convex voice test passed ticket handoff, one-use enforcement, committed board publication, playback completion, rotation and reconnect without replay.

The pinned Better Auth package still has three high/critical advisory matches in disabled optional flows. There is no currently supported fixed Better Auth/Convex-adapter version pair. Password/Convex-only configuration and exact endpoint guards are enforced and tested; no incompatible upgrade, private cryptographic patch or audit suppression was used. This is a documented restricted-configuration exception, not a clean audit. See [dependency review](phase-6-auth-dependency-review.md), [evaluation](phase-6-evaluation.md), [usage and measurements](phase-6-usage.md), [operations](phase-6-operations.md) and [deployment](phase-6-deployment.md).

Vercel CLI sign-in was completed by the user. The selected team is Hobby, with an empty `tokai` project and separate capped-Free Convex release/staging destinations. No billing upgrade or website deployment has occurred. The prospective Vercel upload manifest was checked against28 configured credential values: zero matches and zero prohibited private paths. The417,655,690-byte Windows native bundle passed guarded OCR/embedding and packaged Unicode PDF checks; Linux execution remains a hosted gate. Physical-device, assistive-technology and independent human curriculum validation remain explicit evidence limits.

## Voice-first redesign and milli rebrand (in progress, 2026-11-04)

For the AssemblyAI voice hackathon the web UI was redesigned in a cleaner, voice-first style and the visible brand changed from milli to **milli** (internal `@milli/*` package names, storage keys and worklet names are unchanged so existing guests keep their data).

- New design layer `apps/web/src/app/milli.css` (Inter, white surfaces, chunky pressable buttons, bright green accent) plus updated tokens and product-module styles. Page titles and helper copy were shortened.
- Lesson screen: top progress bar (lesson phase when the tutor reports one, otherwise a turn-based estimate), compact Sample/Live badge, collapsible study panel, and a bottom voice dock with an animated orb (listening reacts to the measured mic level; thinking/speaking states), live captions, push-to-talk on the orb or by holding Space when no control is focused, latency pill from measured first-audio time, and quick prompts. Tutor-highlighted board ideas pulse while milli speaks.
- Home: one question ("What do you want to learn?") with typed or AssemblyAI-dictated topics that open the new-lesson form, a continue card, topic cards and saved lessons. New lesson: numbered sections with dictation for the topic.
- Sample lessons still disable voice and say so; prepared responses remain labeled as not live AI.

Checks run: `pnpm typecheck`, web unit tests (61 + 13 node) and the production web build passed. All 31 e2e scenarios passed with selectors updated for the new copy (one failure was a hydration mismatch from editing copy mid-run; that spec passed on rerun). Real-device voice and screen-reader checks of the new dock have not been done.

### Voice-first hackathon pass (2026-11-04/05)

- **Earlier tutor provider priority (superseded below):** Tutor turns, courses, lesson plans, rubric grading, cards and recaps initially tried Gemini, Groq, then Cerebras. Learner cancellation stops the chain. Groq and Cerebras were tested with mocked HTTP because local keys were unavailable. Board-image explanations use Gemini.
- **Word timings are best-effort** as AssemblyAI documents: missing, disabled or malformed `WordBoundaries` no longer fail speech. Timings are forwarded as `audio.words` for word-by-word captions and board ideas light up when milli says their names.
- **Voice UX:** hands-free by default (remembered; push-to-talk available), milli speaks the opening line when talk mode starts, typing collapses behind “Type instead” while the mic is on, tutor questions can be answered out loud (with “Ask instead”), short spoken commands (show/hide 3D, open concepts/practice/transcript, repeat, finish lesson) act on the UI without a tutor turn, a “Teach it back” prompt, and a curated AssemblyAI voice picker with server-side previews (`POST /v1/voices/:voiceId/preview`).
- **Two-voice audio recap:** live lessons rewrite the recap as a milli/Sam dialogue (facts restricted to the recap) and speak it in two voices with speaker-marked captions; it falls back to the single-voice recap.
- **Simplified UI:** camera gestures are an opt-in experiment in Settings, board editing tools sit behind “Edit board”, Cards appear after the lesson, navigation is Learn · Review · Settings, usage limits are collapsed, Live AI is the default on Home (offline demo still labeled), and saying a topic on Home starts a live lesson directly.

Not done: persistent TTS WebSocket reuse across beats (each beat still opens a session), real-device/AEC tuning for hands-free, and phone calling.


### milli adaptive adaptive agentic tutor (2026-11-04)

- **Sole clean milli lesson UI (`apps/web`):** Replaced the cluttered whiteboard/chat workspace on `/learn/[id]` completely with `LessonPlayer.tsx` (`CourseVisuals.tsx`, `CourseInteractions.tsx`, `MilliMascot.tsx`, `useLessonAudio`, `useInlineMic`). Includes the minimal top bar (close, green progress bar, interactive syllabus study-track dots & popover, voice mute toggle, honest `Sample` / `Live AI` badge, XP counter), centered rounded card with green border on correct answers, left flag/speaker rail, and bottom-left milli companion with one-tap inline voice capture (`v` shortcut with live RMS waveform & silence endpointing) and typed input (`/` shortcut).
- **Contracts & deterministic engine (`packages/contracts`):** Added `course.ts` and `course-engine.ts` with validated schemas (`CourseScriptSchema`, `CourseStepSchema`, `CourseVisualSchema`, `CourseInteractionSchema`, `CourseProgressSchema`, `StartCourseSessionSchema`, `PrepareChapterRequestSchema`, `CourseTurnRequestSchema`, `CourseTurnReplySchema`), a safe math expression evaluator (`compileMathExpr`, `evalMathExpr` — no `eval` or `Function`), `splitStepTeaching` + `summarizeCourseAnswer`, deterministic grading for all 9 interaction types (`mcq`, `true-false`, `fill-tiles`, `fill-input`, `order`, `match`, `categorize`, `mark-points`, `slider`), answer reveal, and semantic step validation.
- **Adaptive Agentic Teaching Loop (`packages/tutor-core` & `apps/api`):**
  1. **Fast First-Concept Start & Progressive Syllabus:** `POST /v1/courses/start` creates the owned lesson session immediately without upfront multi-call blocking; `GET /v1/sessions/:id/course` (`generateInitialCourse`) plans the syllabus and generates Chapter 1 immediately while marking Chapters `2..N` `pending`; `POST /v1/sessions/:id/course-prepare` (`generateNextCourseChapter`) generates remaining chapters asynchronously in the background using learner history.
  2. **Teach & Speak Concept First → Ask Question (AssemblyAI-only speech, no browser fallback):** Each interactive step begins in `teach` stage (displaying the concept & SVG visual while milli speaks `conceptSpeech` via AssemblyAI `assemblyai-tts-1`) and transitions automatically on completion (or via `Ready for question`) to `practice` stage (revealing the question widget and speaking `questionSpeech`). Browser `window.speechSynthesis` fallback has been completely removed: if AssemblyAI TTS (`assemblyai-tts-1`) or STT (`universal-3-6-pro`) is unreachable, milli explicitly alerts the learner that AssemblyAI is unreachable and automatically opens the typed chat input so the lesson continues seamlessly via chat.
  3. **Goal-Directed Adaptive Turn Loop (`POST /v1/sessions/:id/course-turn`):** `runAgenticCourseTurn` (with deterministic `Sample` counterpart `deterministicAgenticTurn`) praises why right answers work, diagnoses specific misconceptions on wrong checks, dynamically splices validated remedial stepping-stone steps (`insertedStep`) into the active chapter on repeated struggle, grades spoken/typed answers (`markStepSolved`), and answers off-script learner side-questions (`intent: 'side-question'`) while displaying and speaking a `bridgeText` card that smoothly brings the learner back onto the prepared study track until all syllabus chapters are complete.
- **Verification:** `pnpm typecheck`, `pnpm test`, `pnpm api:spec:check`, `pnpm build`, and Chromium e2e walkthrough (`tests/e2e/milli-course-player.spec.ts`) verified fast start, `teach` → `practice` progression, off-script side-question + bridge-back, remedial step splicing, and XP completion.

### Live Teacher Pedagogy, Unified Speech & Slide Animation (2026-11-04)

- **Unified Single-Call Speech Delivery:** Eliminated the double API call roundtrip (previously splitting concept narration and question prompt into two sequential network calls). `splitStepTeaching` now combines concept setup and question posing into a unified `combinedSpeech` string with `part: 'step'` on `/v1/sessions/:id/course-speech`. Milli speaks the concept hook and question prompt in one continuous, natural breath.
- **On-demand lesson audio:** Next-step prefetch competed with the current narration for the learner's speech slot and could surface a capacity rejection as an AssemblyAI outage. The player now requests narration on demand and caches successful audio for replay. The silent playback primer uses a blob URL allowed by the browser's media policy. A live Chromium run played the Circuits opening with one successful AssemblyAI speech request and no speech alert or policy violation.
- **Silky Slide-in Chat & Explain Panel:** When the learner taps typing, presses `/`, or triggers "Why?" / wrong answer clarification, `.milli-course-stage` smoothly expands with `.is-split.has-chat-open`. The main card slides right (`transition: max-width 0.38s cubic-bezier(0.16, 1, 0.3, 1), transform 0.38s ...`) and the conversation panel smoothly slides in from the left with `milliSlideInLeft` keyframe animation. Features a dedicated header (`milli`, status indicator, volume toggle, close `X`), recent dialogue history thread, tutor response bubble with intent badges, visual clarifiers, syllabus bridge card, quick replies, and an integrated in-drawer composer.
- **Natural 1-on-1 Teacher Voice & Prompting:** Refined `STEP_AUTHORING_RULES` in `packages/tutor-core/src/course.ts` to instruct the AI tutor to speak like an inspiring human mentor pointing to visuals rather than reading dry text passages.
- **Markdown Rendering Fix in Feedback Bubbles:** Replaced unparsed `<p>{bubbleText}</p>` with `<FormattedStepText text={bubbleText} />` in `.milli-course-floating-bubble`, eliminating raw markdown asterisks (e.g. `**Yep!**`) and rendering crisp bold highlights, math KaTeX, and code chips.
- **Faster Inline Voice Endpointing:** Tuned `useInlineMic.ts` post-speech silence cutoff from 1.4s to ~900ms once user speech has been detected, shaving ~500ms of dead air on spoken turns.
- **Tutor responsiveness:** Correct widget answers and “Why?” can speak the validated lesson explanation directly. Adaptive replies still use the model for misconceptions and learner questions. Auto-ended mic clips retain about 250 ms of trailing silence before upload, so the API has up to 650 ms less audio to replay to transcription. Practice opens on the audio end event. The player queues progress writes in revision order and cancels a pending tutor turn when the learner moves on.
- **Conversational lesson turns:** Course steps can ask an open question without a widget. Live learners can answer aloud or type, with model feedback on what they understood and a follow-up when something is missing. The Circuits sample has a prepared question and a plot demonstration. Validated plot demonstrations apply during teaching and reset for practice. A bound plot slider supplies the learner's actual answer and recognizes a settled target value.
- **Live course response fix:** Gemini returned HTTP 400 when the nested course schema was sent as a response constraint. The course adapter now requests JSON and validates it against the original schema locally. A real Gemini probe generated a spoken circuit question, and a separate live turn accepted a correct paraphrase. Chromium covered typed retry, the graph demonstration, the practice reset, and automatic feedback at the target. A physical microphone walkthrough remains unverified.
- **Lesson diagram layout:** Shape diagrams fit their actual geometry inside a bounded SVG viewport, so tall generated drawings stay above the question and answer controls. The typed answer field and submit button share a separate row.
- **Featured lessons:** The home cards start prepared, owner-scoped course scripts in both modes. Live mode adds provider speech and adaptive turns. Offline mode uses prepared feedback. The photosynthesis chart is an explicitly simplified model and the leap-year chart uses illustrative data. Lesson background references include [OpenStax photosynthesis](https://openstax.org/books/biology/pages/8-1-overview-of-photosynthesis), [NASA on orbits](https://science.nasa.gov/solar-system/orbits-and-keplers-laws/) and [NASA on Mars years](https://science.nasa.gov/resource/mars-in-a-minute-how-long-is-a-year-on-mars/). Graph points can be entered by keyboard, and completed lessons offer recall cards and downloadable course notes.
- **Featured verification:** Completed all four offline lessons in Chromium. The tall-diagram desktop/mobile regression passed on its focused rerun. A separate live Circuits browser run opened the authored path, played real AssemblyAI audio and received a live Gemini reply. Typecheck, tests, build and OpenAPI checks passed.
- **Verification:** `pnpm typecheck`, `pnpm test` (all 123 tests passing), `pnpm api:spec:check`, `pnpm build`, and all 3 Playwright E2E tests in `tests/e2e/milli-course-player.spec.ts` passed cleanly.


### Conversational milli and orb companion (2026-11-04)

- Replaced the geometric mascot with the MIT-licensed Thinking Orbs component, tied to actual speaking, listening, thinking and idle state. Noninteractive status orbs are no longer inert buttons. The library respects reduced motion and pauses offscreen.
- Fixed unreadable learner messages: formatted paragraphs and bold text now inherit the dark-green text color on a light-green bubble.
- Course authoring and follow-up prompts now request brief example-led teaching, conversation continuity, one question per turn and grounded observations of widget state. Removed repetitive generic comprehension checks and duplicate spoken return invitations. These are model instructions, not a guarantee of every generated response's quality.
- Renamed workspace packages to @milli and lesson CSS/test identifiers to milli. Removed former product/style branding in source and documentation. Historical reference paths, existing persistent session/authentication keys, environment settings and local data-directory names remain compatible so existing sessions and credentials still work. No other project was changed.

- Verification: `pnpm typecheck`, `pnpm test`, `pnpm build`, and OpenAPI drift check passed. Seven browser regressions passed together, including chat colors and orb visibility with reduced motion. Fractions completed but its test teardown raced a pending routed response; waiting for routes during cleanup fixed the focused rerun. Live microphone naturalness was not evaluated in this pass.


### Live course voice audit (2026-11-04)

Tested the local Circuits lesson in Chromium using a generated two-sentence WAV as microphone input, real AssemblyAI recognition/synthesis and real Gemini replies. This is not a physical microphone, accent/noise or subjective listening evaluation.

- Found that 900 ms endpointing cut off the second sentence after a natural pause. Increased the pause allowance to 1.3 seconds; both sentences then reached transcription.
- Replaced the lesson microphone's record-then-replay HTTP path with a bounded WebSocket relay. It authenticates the guest or signed-in cookie, verifies session ownership and live mode, checks Origin, enforces one stream per owner and four active streams globally, meters up to thirty seconds, and closes on cancellation. Auth is in the first message or cookie, never the URL. Schemas live in contracts. Existing short HTTP dictation remains available to other screens.
- Measured transcription after recording ended: about 338 ms with streaming, versus 10.8 and 14.0 seconds for the earlier buffered path. Speech interruption paused browser playback in about 50–114 ms in these runs. These are a few local observations, not percentile benchmarks.
- Simplified normal conversation's model response schema; retained nested course generation for remediation. Used the configured Gemini 3.5 Flash-Lite model's [documented minimal thinking level](https://ai.google.dev/gemini-api/docs/generate-content/thinking) for ordinary turns. No provider order or credentials changed.
- Provider latency remains a limitation: successful Gemini turns took roughly 16–21 seconds, and others hit the deadline. A bounded comparison found the older 2.5 Flash-Lite request returned 404 and 3.1 Flash-Lite returned 503, so no unverified model replacement was made. Groq and Cerebras keys are absent locally.
- Live fallback now explicitly says a reply could not be obtained, instead of speaking a canned explanation as if it answered the learner. A successful live reply correctly corrected the battery-creates-electrons misconception. Follow-up success was inconsistent because of provider timeouts.
- Interrupting through the mic cancels a pending model response as well as playing audio. Validated answers during teaching can complete the active question without requiring a repeat. Voice replies include the generated return invitation when there is no question already spoken. Removed the repeated generic lesson opening.
- Added relay tests for streamed audio, multiple sentences, ownership, cookie identity, Origin and oversized frames; model tests for compact responses and honest fallbacks; and a browser regression for early answers. Generated audio and timing probes stay under ignored `.logs`.

- Final live rerun: streamed transcription returned in 328 ms after finish; milli corrected the misconception and spoke a specific question about the return wire. The next accurate typed answer was evaluated live, marked solved during teaching and earned 15 XP. That follow-up took 4.2 seconds for the model and 4.5 seconds for TTS; the preceding model turn took 18.5 seconds. Observed interruption varied from about 50 ms to 493 ms across runs, including concurrent build/test load. Voice clips played in Chromium and were saved, but no subjective prosody rating is claimed.

- The final transcript exposed a 280-character history truncation that dropped the tutor’s follow-up question. History now preserves the full bounded spoken reply, with a browser regression confirming the question is sent in the saved conversation.


### Groq-first routing and live verification (2026-11-04)

- At the user's request, the shared text-model chain is now **Groq → Cerebras → Gemini**. This covers tutor turns, course generation/replies, learning plans, cards, grading and recaps. Unconfigured providers are skipped; cancellation stops the chain. Board-image explanations still use the existing Gemini vision adapter.
- Reloaded the newly configured local Groq and Cerebras keys by restarting the API. Keys were not printed or moved to client code.
- A real Groq course reply completed in 904 ms without invoking a fallback. A separate Cerebras-only probe completed in 882 ms. Mocked failover tests verify both failures reach Gemini, and successful Groq calls stop the chain.
- Full Chromium voice rerun used real AssemblyAI and the updated routing. Streaming transcription returned 333 ms after finish. Course reply requests took about 2.4 and 1.6 seconds, both live; the second answer completed the question with 15 XP. Including speech synthesis, response playback started about 8.6 seconds after the first recording ended and 2.8 seconds after the typed follow-up. These are local sample measurements, not latency guarantees. The microphone source was generated test speech, not a human microphone.

- Validation: typecheck, all configured unit tests, production build and OpenAPI drift check passed after the routing change. The eight existing course browser regressions and both focused new regressions passed. One earlier Windows test-worker process exited unexpectedly; the full test rerun passed. Database integration suites requiring separate services retain their existing skips.

### Landing, courses and native account entry (2026-11-04)

- The public `/` route is now a dedicated milli landing page with an accessible example of the spoken, hands-on tutoring loop. The working learning hub moved to `/learn`.
- Navigation now contains only **Learn**. Review and new-lesson controls are removed from the visible product surface. Topic text or dictation in Learn is the entry point for creating a live course; prepared cards remain available for explicit offline practice. Legacy `/review` and `/learn/new` URLs redirect to `/learn`.
- The profile menu holds **Courses**, **Settings** and **Sign in** (or Account for a signed-in learner). `/courses` lists every non-archived course scoped to the current guest or account. The continuing-course card on Learn is capped at 680px rather than spanning the content area.
- Native Convex/Better Auth email-password sign-in was already present and remains the account system. The landing/profile entry points now expose it, and successful sign-in goes to Courses. Native auth is live locally; email verification and password recovery remain intentionally unavailable and are disclosed on the sign-in screen.
- Verification after the navigation change: workspace typecheck, workspace tests and production web build passed; focused Chromium Circuits interactive-lesson regression passed. The local Convex watcher had been left at an account-link prompt, which made the API fail closed with `DATABASE_UNAVAILABLE`; it was restarted in anonymous-agent mode and API/web, live tutor, speech, and native auth health are now available locally.
