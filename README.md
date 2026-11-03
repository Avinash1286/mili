# Tokai

A voice-first learning workspace: a tutor that explains, draws, listens, and helps you practice.

This is the new implementation in `F:\mili` for AssemblyAI's **Hack into speech** event. The complete product specification is [imp.md](imp.md). The original Agora prototype remains separate in `F:\tokai-agora`.

## Current delivery: Phase 2 implementation

Phase 1's responsive learning space and four authored **sample lessons** are approved and pushed to the private [GitHub repository](https://github.com/Avinash1286/mili). Phase 2 adds an authenticated streaming voice path, microphone/audio worklets, interruption, shared typed/voice conversation, and playback diagnostics. Real Gemini/AssemblyAI access and microphone quality remain unverified until local keys are configured. See [progress](docs/progress.md), [Phase 2 testing](docs/phase-2-testing.md), and the [voice protocol](docs/voice-protocol.md).

Samples remain authored examples. Structured visual teaching, production database/authentication, gestures, 3D models, and learning evaluations remain later work.

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
- `packages/contracts`: shared Zod schemas and API types.
- `packages/tutor-core`: authored sample lessons and tutoring foundations.
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

Provider tests use local test responses; voice browser tests inject fixtures into a separate test API. Live credentialed calls are separate and opt-in: `pnpm verify:tutor --live` and `pnpm verify:speech --live --streaming`. Installation and ordinary test commands do not call paid providers. Probe recordings are ignored under `var/probes/`.

## Security and scope

Guest sessions are scoped by expiring bearer credentials. Keep the development API local; this phase is not a publicly hardened deployment. Browser data clearing removes the guest credential and therefore access to its local sessions. Account recovery/claiming and PostgreSQL persistence are planned.

Sample materials are examples intended to verify the learning interface, not a validated curriculum or evidence of educational effectiveness. The original prototype's production claims and historical demo are not claims about this checkout.
