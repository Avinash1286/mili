# Tokai

A learning workspace with voice tutoring, editable diagrams, concept maps, optional local hand gestures, interactive 3D models and evidence-based practice.

Built in `F:\mili` from the product direction in the separate `F:\tokai-agora` prototype. The complete specification is [imp.md](imp.md); checked work and remaining limitations are recorded in [progress](docs/progress.md).

## Delivery

Phases 1–4 are pushed to the private [GitHub repository](https://github.com/Avinash1286/mili). Phase 5 is implemented and checked locally: Convex persistence and durable AI jobs, local accounts, PDF/image/text sources, five assessment formats, four card formats, scheduled review, study packs, narrated recaps, exports and revocable sharing. The final checks passed 308 tests and the production build; see [Phase 5 testing](docs/phase-5-testing.md) and the exact browser/integration evidence in [progress](docs/progress.md). Phase 6 deployment hardening remains underway.

Prepared English samples are explicitly labeled. Gemini supplies live tutoring; AssemblyAI supplies transcription and speech. No paid fallback or account upgrade is enabled. A real live diagram probe passed with the existing configured model, taking about 37 seconds; this is functional but slower than the conversational target. See the [provider check](docs/phase-5-provider-check.md).

The chosen stack is Convex plus a persistent Fastify voice/API service, with the website to be deployed through Vercel after local release checks. GitHub Actions are not used. Demo videos and submission materials are deferred.

## Local setup

Requires Node.js24 and pnpm10.33.0. Full local accounts additionally use Java25 and the verified native Keycloak installation. Start with:

```powershell
cd F:\mili
pnpm install --frozen-lockfile
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
pnpm assets:sync
pnpm models:sync
```

Set provider keys only in ignored `.env`. Follow the [local infrastructure guide](infra/local/README.md) once to initialize native Convex, service credentials and local sign-in. Existing Phase1–4 data has an idempotent importer with backups; never replace a saved database with a fresh seed.

Keep Convex and the optional identity server running in separate terminals:

```powershell
pnpm local:convex
```

```powershell
pnpm local:identity
```

Then start the app:

```powershell
pnpm dev
```

Open [Tokai](http://localhost:3000). [API readiness](http://localhost:4000/health/ready) reports the actual persistence adapter. `pnpm dev` runs a stable API; restart it after API/environment changes. `pnpm dev:api` enables API file watching.

The API reads `.env` then `.env.local`. Browser API URL overrides belong in `apps/web/.env.local`. A checkout without Convex configuration has an explicit file compatibility mode for samples/tests; it does not run durable Convex background work. The full feature set requires the Convex setup.

## Workspace

- `apps/web`: Next.js, accessible product screens, board, gestures, 3D and browser audio.
- `apps/api`: authenticated Fastify routes, WebSocket voice, bounded native processing and job execution.
- `convex`: transactional owner-scoped storage, private files, scheduled actions and retention cleanup.
- `packages/contracts`: browser-safe schemas and scene reducers.
- `packages/tutor-core`: sample lessons, bounded Gemini teaching and learning generation.
- `packages/speech`: server-only AssemblyAI adapters and playback lifecycle.
- `packages/learning`: assessment, evidence, cards, scheduling and study-pack algorithms; private answer keys stay server-side.
- `packages/grounding`: bounded PDF/text/OCR parsing and local CPU embeddings.
- `packages/db`: Convex adapters and isolated file test/legacy adapters.

`.convex`, `.tokai`, `.tokai-models`, `.env*` and provider probe recordings remain ignored. Their manifests/setup scripts are tracked.

## Checks

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm assets:check
pnpm models:check
```

Ordinary tests use isolated temporary data and injected providers. Real local infrastructure checks are opt-in and clearly identified. `pnpm verify:local-learning` exercises actual Convex scheduling, private upload, text PDF parsing, scanned-page OCR, vector retrieval and owner isolation, then deletes its temporary learner.

Provider checks are separate and consume the configured account quota: `pnpm verify:tutor --live`, `pnpm verify:teaching --live --rounds=1 --timeout=45000` and `pnpm verify:speech --live --streaming`. No check changes billing. Probe output under `var/probes` is ignored.

## Privacy and limitations

Provider credentials remain server-side. Expiring guest credentials identify this browser's workspace; sign-in can claim it. Uploads and generated downloads are authorized, shares are opt-in/revocable, transcript and recap retention are explicit choices, and source parsing runs in a bounded child without provider credentials. Camera pixels remain local; sharing a board crop is a separate explicit action.

Local OCR and the compact embedding model are English-focused. Prepared reference packs have source attribution and automated consistency checks; independent teacher review and educational-effectiveness validation are not claimed. Physical hand recognition, combined real-device audio/graphics behavior, Safari/iOS and screen-reader checks remain distinct from Chromium fixtures. See [provenance](docs/provenance.md).
