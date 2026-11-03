# Implementation progress

Full scope: [imp.md](../imp.md). New root: `F:\mili`.

## Delivery agreement

- Work phase by phase.
- At the end of each phase, report what was delivered, checks actually run, limitations, and exact user testing steps.
- Pause for the user's testing/feedback before starting the next phase.
- Do not push to GitHub until explicitly asked. No remote is configured by this phase.

## Phase 1 — foundation and sample lesson

Status: delivered on 2026-11-03; awaiting user testing and feedback before Phase 2.

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

User handoff: [Phase 1 testing checklist](phase-1-testing.md). No GitHub remote, commit, or push has been created. Phase 2 has not started.

## Following phases (start only after the preceding user test)

1. **Phase 2 — live voice loop:** credentialed Gemini and AssemblyAI verification, streaming STT/TTS, browser worklets, interruption, transcript deduplication, measured latency. Complete backend ownership/persistence prerequisites as required.
2. **Phase 3 — teaching and visual coordination:** structured tools, semantic board/tldraw adapter, beat/audio coordination, selection grounding, concept map.
3. **Phase 4 — gestures and spatial lessons:** local MediaPipe, calibration, accessible alternatives, licensed 3D catalog and part selection.
4. **Phase 5 — durable learning:** accounts/PostgreSQL where not already delivered, source upload/retrieval, assessments, mastery evidence, scheduled reviews, summaries/recaps, exports and sharing.
5. **Phase 6 — release and hackathon proof:** real-device/accessibility/security/fault checks, capacity and cost measurements, deployment/restore, provenance, demo and verified submission obligations.

These are reviewable delivery increments across the full imp.md dependency graph. They do not remove planned work. If an increment is too large to review, split it into numbered subphases and stop for testing at each boundary.
