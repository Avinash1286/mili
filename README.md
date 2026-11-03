# Tokai

A voice-first learning workspace: a tutor that explains, draws, listens, and helps you practice.

This is the new implementation in `F:\mili` for AssemblyAI's **Hack into speech** event. The complete product specification is [imp.md](imp.md). The original Agora prototype remains separate in `F:\tokai-agora`.

## Current delivery: Phase 1

Project foundation and a runnable, explicitly labeled **sample lesson**. Sample replies are authored examples, not live AI. The full voice tutor, production database/authentication, gesture recognition, 3D models, and learning evaluations remain later work. See [progress](docs/progress.md) and [testing instructions](docs/phase-1-testing.md).

Development proceeds one phase at a time. After each phase, the user tests it before the next phase begins. GitHub pushes require the user's explicit instruction.

## Run locally

Requires Node.js 24 and pnpm 10.33.0.

```powershell
cd F:\mili
pnpm install --frozen-lockfile
pnpm dev
```

Open [Tokai](http://localhost:3000). The local API runs at [localhost:4000](http://localhost:4000/health/live). No API key is needed for sample lessons.

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
- `packages/speech`: server-only AssemblyAI synthesis and playback lifecycle helpers.
- `.tokai`: ignored local session data; not a production database.

## Checks

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Provider tests use test responses. Live credentialed calls are separate and opt-in; no installation or normal test command should spend provider credits.

## Security and scope

Guest sessions are scoped by expiring bearer credentials. Keep the development API local; this phase is not a publicly hardened deployment. Browser data clearing removes the guest credential and therefore access to its local sessions. Account recovery/claiming and PostgreSQL persistence are planned.

Sample materials are examples intended to verify the learning interface, not a validated curriculum or evidence of educational effectiveness. The original prototype's production claims and historical demo are not claims about this checkout.
