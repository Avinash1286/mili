# Tokai

A voice-first learning workspace: a tutor that explains, draws, listens, and helps you practice.

This is the new implementation in `F:\mili` for AssemblyAI's **Hack into speech** event. The complete product specification is [imp.md](imp.md). The original Agora prototype remains separate in `F:\tokai-agora`.

## Current delivery: Phase 3 user testing

Phases 1 and 2 are approved and pushed to the private [GitHub repository](https://github.com/Avinash1286/mili). The foundation includes four authored **sample lessons**, an authenticated streaming voice path, microphone/audio worklets, interruption, shared typed/voice conversation, and playback diagnostics. Phase 2 passed live provider checks and the user's testing. Phase 3 adds editable semantic diagrams, concept maps, bounded Gemini teaching tools, explicit drawing-image sharing, and visual readiness/playback coordination. See [progress](docs/progress.md), [Phase 3 testing](docs/phase-3-testing.md), and [architecture decisions](docs/phase-3-architecture.md).

Samples remain authored examples. Production database/authentication, gestures, 3D models, source ingestion and learning evaluations remain later work. Direct Gemini plus AssemblyAI speech uses the configured accounts; the application does not upgrade accounts or enable a paid fallback.

Phase 3 passes 161 unit/integration tests and 12 browser walkthroughs. Its live Gemini diagram probe returned a temporary HTTP 503; live diagram generation, image explanation quality and device speech/visual timing still need user verification. Browser tests use injected providers and do not establish these live results.

Development proceeds one phase at a time. After each phase, the user tests it before the next phase begins. GitHub pushes require the user's explicit instruction.

## Run locally

Requires Node.js 24 and pnpm 10.33.0.

```powershell
cd F:\mili
pnpm install --frozen-lockfile
pnpm dev
```

Open [Tokai](http://localhost:3000). The local API runs at [localhost:4000](http://localhost:4000/health/live). No API key is needed for sample lessons.

`pnpm dev` runs a stable API process alongside the frontend development server. Restart it after API code or environment changes. For API-only development with file watching, use `pnpm dev:api` in its own terminal.

Optional server configuration:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

Do not overwrite an existing `.env`. Fill in keys locally, never in source code. The API loads the root `.env`; public frontend URL overrides belong in `apps/web/.env.local` if a different API address is needed. Restart processes after configuration changes.

## Workspace

- `apps/web`: Next.js learning UI.
- `apps/api`: persistent Fastify API and local guest/session storage.
- `packages/contracts`: shared Zod schemas, semantic scenes, diagram layout and transactional reducers.
- `packages/tutor-core`: authored sample lessons, bounded Gemini tools, teaching-plan validation and explicit image explanations.
- `packages/speech`: server-only AssemblyAI STT/TTS adapters and playback lifecycle helpers.
- `.tokai`: ignored local session data; not a production database.

## Checks

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Provider tests use local test responses; all browser tests inject fixtures into a separate test API. Live credentialed calls are separate and opt-in: `pnpm verify:tutor --live`, `pnpm verify:teaching --live --rounds=2`, and `pnpm verify:speech --live --streaming`. The teaching probe allows at most two model calls with zero repair attempts and validates a temporary lesson without saving it. Installation and ordinary test commands do not call providers. Probe recordings are ignored under `var/probes/`.

## Security and scope

Guest sessions are scoped by expiring bearer credentials. Keep the development API local; this phase is not a publicly hardened deployment. Browser data clearing removes the guest credential and therefore access to its local sessions. Account recovery/claiming and PostgreSQL persistence are planned.

Sample materials are examples intended to verify the learning interface, not a validated curriculum or evidence of educational effectiveness. The original prototype's production claims and historical demo are not claims about this checkout.
