# Tokai

A voice-first learning workspace: a tutor that explains, draws, listens, and helps you practice.

This is the fresh implementation in `F:\mili`, based on the product direction in the separate `F:\tokai-agora` prototype. The full specification is [imp.md](imp.md).

## Current delivery: Phase 4

Phases 1–3 are pushed to the private [GitHub repository](https://github.com/Avinash1286/mili). Phase 4 passed 198 unit/integration tests, 21 browser scenarios and the production build. It adds optional local camera gestures and four interactive 3D models to the existing voice tutoring, semantic whiteboard, concept maps, image sharing and coordinated teaching beats. See [progress](docs/progress.md) and [Phase 4 testing](docs/phase-4-testing.md).

The four guided samples are clearly labeled authored examples. Direct Gemini provides live tutoring and AssemblyAI provides speech; no account upgrade or paid fallback is enabled. Phase 2 passed limited live provider probes and user testing. Phase 3's live diagram probe encountered HTTP 503; live visual-provider quality and physical-device performance remain unverified. Browser provider fixtures do not establish those results.

The user authorized completing the remaining phases and pushing after each checked phase. Accounts, PostgreSQL persistence, source ingestion, assessments and the complete study/review workflow are next. The current destination is a complete local deployment; hosting, submission materials and demo videos are deferred.

## Run locally

Requires Node.js 24 and pnpm 10.33.0.

```powershell
cd F:\mili
pnpm install --frozen-lockfile
pnpm assets:sync
pnpm dev
```

Open [Tokai](http://localhost:3000). The API runs at [localhost:4000](http://localhost:4000/health/live). Samples need no provider keys. Asset sync verifies checksums and downloads the official hand model for local use. The external task weights are excluded from Git; runtime code, manifests and four original 3D assets are tracked. `pnpm assets:check` verifies local assets without network requests.

`pnpm dev` runs a stable API and the frontend development server. Restart after API or environment changes. API-only file watching is available with `pnpm dev:api`.

To initialize configuration without replacing an existing file:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

Fill keys locally, never in source code. The API loads root `.env`; frontend URL overrides belong in `apps/web/.env.local`. Restart after configuration changes.

## Workspace and checks

- `apps/web`: Next.js UI, board, gestures, spatial viewer and browser audio.
- `apps/api`: persistent Fastify API and local guest/session storage.
- `packages/contracts`: browser-safe schemas and semantic scene reducers.
- `packages/tutor-core`: sample lessons, bounded Gemini tools and image explanations.
- `packages/speech`: server-only AssemblyAI adapters and playback lifecycle.
- `.tokai`: ignored local session data, pending the PostgreSQL phase.

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Ordinary tests use temporary storage and injected tutor/speech providers. Live checks are separate and opt-in: `pnpm verify:tutor --live`, `pnpm verify:teaching --live --rounds=2`, and `pnpm verify:speech --live --streaming`. The teaching probe permits at most two model calls with no repair attempts and saves no lesson. Probe recordings are ignored under `var/probes/`.

## Privacy and current limits

Provider keys stay server-side. Expiring guest credentials scope saved data; clearing browser storage removes access to those guest lessons. Keep this development API local until the persistence/authentication and release phases are checked. Camera pixels remain on the device; explicit drawing-image sharing is a separate action.

Sample materials verify application behavior; they are not a validated curriculum or evidence of educational effectiveness. See [provenance](docs/provenance.md) for original work and dependency/asset attribution.
