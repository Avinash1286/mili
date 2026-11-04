# Phase 5 local architecture — Convex

Status: implemented locally; final integrated checks are recorded in [progress](progress.md). Updated 2026-11-03 after the user selected Convex for persistence and AI background jobs. This decision supersedes the PostgreSQL/Redis/Drizzle/BullMQ/S3 draft. Complete the application locally first, then deploy through Vercel as authorized. Presentation materials remain deferred. GitHub Actions are not used.

## Runtime and ownership

Keep Node.js 24, pnpm, Next.js and the persistent Fastify API. Fastify owns Gemini/AssemblyAI connections, WebSocket audio, native parsing and provider secrets. Convex owns durable records, transactional scheduling, native file storage and source indexes.

Prefer the official CLI's native Windows anonymous deployment when available. It requires no cloud account, stores state in the checkout's ignored `.convex/` directory, and runs while `convex dev` runs. It is a documented beta development deployment, not production hosting. A persistent self-hosted Docker backend/dashboard is the alternative; its default local database and native files need no additional PostgreSQL, Redis or S3 service. [Local deployments](https://docs.convex.dev/cli/local-deployments), [anonymous agent setup](https://docs.convex.dev/cli/agent-mode), [self-hosted backend](https://github.com/convex/convex-backend/blob/main/self-hosted/README.md).

Local Keycloak supplies OIDC accounts, with an isolated realm/client and persisted state. Do not implement password storage in milli. Docker Desktop currently has an independently diagnosed stale Windows socket problem. Its zero-byte Secrets Engine socket directory was preserved and the app restarted; startup then reached the analogous Docker/run/dockerInference socket. No volumes/settings were reset, and no PostgreSQL/Redis/S3 containers were created.

## Authentication

Guest bearer tokens and HttpOnly account session cookies authenticate to Fastify. Store token hashes, stable owner IDs, expiration and revocation. `Principal.hash` remains a compatibility alias of ownerId, not an OIDC credential.

Fastify authenticates to Convex with a five-minute RS256 service JWT: audience `tokai-convex`, subject `tokai-service`, explicit issuer, and server-only private key. Convex verifies a public JWKS data URI and every public function checks issuer/subject. No secret arguments or administrator runtime key are needed. Each record operation separately checks the application principal against durable owner/auth state. [Custom JWT configuration](https://docs.convex.dev/auth/advanced/custom-jwt).

OIDC uses discovery, authorization code + PKCE, one-use state, nonce and issuer/audience/signature checks. Cookie mutations require the configured app Origin. Provider tokens never become browser lesson credentials. Guest claim transfers work atomically and invalidates the old guest; logout, claim and deletion close active voice ownership.

## Persistence contract

`packages/db` exposes Store, ConvexStore and an explicitly single-process FileStore compatibility adapter. Convex tables hold owners/auth sessions, canonical session snapshots, typed owner resources, events, idempotency receipts, jobs, leases, source chunks and private file metadata. Browser-safe product schemas remain in contracts.

Resources have `{id,kind,ownerId,sessionId?,revision,data,createdAt,updatedAt}`. Preserve legacy session IDs, board/map revisions, student authorship, delivery state and spatial state/surface. Keep create distinct from update-only save; deletion tombstones reject late callbacks and make session children inaccessible.

Multiple HTTP calls are not a transaction. The compatibility locked callback therefore buffers writes in AsyncLocalStorage and submits one Convex commit mutation. Reads capture owner revision. Commit atomically checks authorization, owner revision, parent tombstones, item revisions and optional lease fence, then applies state/events/receipts/jobs together. Concurrent changes cause409; callbacks with side effects are not blindly retried. Owner-level guards are conservative: measure conflicts before refining to per-aggregate guards.

Named mutations handle identity, jobs and lease acquisition. Provider, parsing and audio waits stay outside persistence transactions. Durable idempotency must not rely only on the last100 UI board operations.

## Jobs, files and retrieval

Enqueue/retry atomically schedules internal.jobs.run({jobId}). Envelopes contain IDs and expected revisions, not source contents or credentials. Convex scheduled mutations are transactional; external actions require explicit bounded retries. Track state, attempt count, worker/fence, lease deadline and idempotent result commits. [Scheduling guarantees](https://docs.convex.dev/scheduling/scheduled-functions).

The scheduled action claims its job and calls a fixed authenticated Fastify /internal/jobs/execute endpoint with a bounded timeout. Fastify runs native OCR/parsing/embeddings and provider adapters, checking ownership and source revisions again before committing. Convex owns scheduling and recovery; Redis/BullMQ are unnecessary. A recovery schedule must survive worker failure after lease renewal. Do not claim exactly-once external billing.

Voice leases use atomic acquisition, expiry and increasing fences. Voice output epoch remains a separate cancellation mechanism. No PCM audio chunks are stored in the database.

Native Convex storage holds bytes. Fastify validates bounded uploads by actual size/signature/checksum and maintains owner-scoped metadata. Private downloads return authenticated bytes: never expose storage.getUrl, whose URLs permit unauthenticated reuse and do not expire as application permissions do. [File access control](https://docs.convex.dev/file-storage/serve-files).

Sources retain versioned chunks, page/section anchors and embedding provenance. Full-text retrieval is an explicit lexical path. Semantic retrieval uses the pinned local all-MiniLM-L6-v2 model and a384-dimensional index scoped by combined owner/source key. Authorize source access before search and before returning documents; missing embeddings are not successful vector search. [Vector indexes](https://docs.convex.dev/search/vector-search).

Text/PDF/image parsing and OCR need real limits and failed states. Retrieved content is untrusted evidence, never tool authority. Cite only persisted chunks/pages. Deletion cancels future work, hides references, removes native files and purges derived records.

## Slices and required proof

| Slice | Required implementation and local proof |
|---|---|
| Persistence | Native backend, legacy import, atomic commits and leases; verify restart, two-owner isolation, conflicts, rollback and late-save rejection |
| Identity | Local Keycloak/OIDC, guest claim/preferences; verify real login/logout, callback replay rejection, old guest revocation and account isolation |
| Jobs/storage | Durable scheduler/API executor/native files; kill/restart mid-job, reject stale workers, test retries and delete-during-work cleanup |
| Learning | Rubrics/attempts/evidence, editable cards and UTC reviews; distinguish hinted answers, handle ambiguous/numeric grading, deduplicate attempts/reviews |
| Grounding | Free-form plans and real PDF/image/OCR sources; verify page anchors, owner filtering, injection fixtures and honest missing evidence |
| Finalization | Heard-aware summary/study pack and optional recap; deduplicate end/retry and preserve useful text when speech fails |
| Product | Onboarding, library/resume, practice/review, notes/exports/shares/deletion; complete local browser journey and authorized downloads |

Samples remain explicitly authored. Mastery requires attempt evidence, not generated narration or “okay.” Preserve review algorithm/version, provenance and learner overrides.

Configuration names: CONVEX_URL, TOKAI_SERVICE_PRIVATE_KEY, TOKAI_SERVICE_JWKS, TOKAI_SERVICE_ISSUER, TOKAI_SERVICE_KEY_ID, TOKAI_JOB_SECRET, INTERNAL_API_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, SESSION_SECRET and upload/retention limits. Store secrets only in ignored local configuration. Self-hosted admin keys, if used, are deployment credentials rather than application runtime credentials.

Phase6 measures local accessibility, security, fault recovery, performance/cost and backup restoration. Distinguish mocked tests, real local service tests and live provider results. Hosting remains a later user-directed step.
