# Phase 6 deployment runbook

Updated 2026-11-04. **Cloud configuration exists; application deployment and Linux runtime verification are not yet complete.** Phase 6 must be committed and pushed, with the final local checks passing, before the website is published. The user authorized Vercel hosting and Convex cloud on existing free accounts. No paid plan, metered Starter upgrade, container registry, or GitHub Actions workflow is used.

## Configured destinations

| Environment | Vercel origin | Convex deployment |
| --- | --- | --- |
| Production | `https://tokai-kappa.vercel.app` | `gen-ai-labs:tokai:release`, `https://glad-ladybug-203.convex.cloud` |
| Preview | Planned stable alias `https://tokai-preview-avinash1286s-projects.vercel.app` — assign after its first build | `gen-ai-labs:tokai:staging`, `https://tame-scorpion-688.convex.cloud` |

Vercel project `tokai`, ID `prj_JNBE4NryhLwcx4q0EeTDo8Mp6Nbl`, belongs to `avinash1286s-projects`. CLI account metadata confirmed **Hobby**. Convex project `tokai` belongs to `gen-ai-labs`; the dashboard billing endpoint returned no subscription, the team is not suspended, and usage state is Default. This is the capped Free configuration; Starter permits paid overages and is not selected. [Convex limits](https://docs.convex.dev/production/state/limits).

Both cloud databases are separate from the local anonymous Convex deployment. No local lessons, credentials, files or database backup were imported into cloud. Root `.env.local` and the local watcher remain pointed at local3210/3211.

## Runtime architecture

`vercel.json` defines two Vercel Services: Next.js under `apps/web` and a Node24 Fastify service with entrypoint `apps/api/src/server.ts`. `/v1/*`, `/auth/*`, `/health/*` and `/internal/*` route to Fastify; `/api/auth/*` remains with the Next.js Better Auth proxy. Application cookies and voice upgrades use the same public origin. Convex owns application snapshots/resources, private files, vectors, admission meters, coordination and durable scheduled jobs. Native OCR/embedding executes through the fixed authenticated Fastify job callback.

Current Vercel documentation explicitly supports WebSockets in Node Functions, including a GA announcement dated October20,2026. This is **bounded connection hosting**, not an always-on daemon guarantee. Hobby functions have a300second ceiling; Tokai drains around240seconds and closes by270seconds with code1012, then requests a new one-use ticket and authoritative snapshot. [WebSockets](https://vercel.com/docs/functions/websockets), [GA announcement](https://vercel.com/changelog/websocket-support-is-now-generally-available), [Fastify](https://vercel.com/docs/frameworks/backend/fastify).

Services is Beta. The native bundle exceeds the standard250MB limit, so the project enables `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`, the documented Large Functions Beta up to5GB. It retains the Hobby300second/2GB function limits. Do not switch to a paid plan or a container registry to mask a failed preview. [Services](https://vercel.com/docs/services), [function limits](https://vercel.com/docs/functions/limitations).

## Implemented hosting boundaries

- **Distributed voice admission:** hash-only,30second, one-use Convex tickets bind owner, application auth session, live lesson and lesson revision. Consumption and owner-fence acquisition are atomic. Strict Origin and actual Upgrade validation run first. Failed handshakes, logout/end/deletion and rotation release or invalidate the matching capability. Connected provider handles and PCM remain local to the accepting process.
- **Rotation:** reconnect clears old epochs, visual gates and queued PCM; it never replays the previous request or audio. Microphone permission can remain available, while hands-free capture is disabled until explicitly resumed.
- **Large private files:**10MiB uploads and up to20MiB downloads bypass Vercel's4.5MB HTTP limit through Convex HTTP actions. API-issued random header capabilities expire within5minutes, are one-use and bind original application auth, resource revision, ownership, consent and operation. They are never query parameters. The handler checks actual byte count, signature/MIME and SHA256, and rechecks authority on finalize/download. No durable public storage URL is exposed.
- **Native assets:** `infra/deploy/build-api.ts` traces the actual child runtime plus `tsx`, restores package-resolution links, includes Tesseract WASM sidecars, checksum-verifies pinned local models, and explicitly packages both Noto PDF fonts. `.env*`, local databases, backups, model caches and Windows dependencies are excluded from upload; Linux rebuilds its own dependencies/assets.
- **Production configuration:** startup requires durable Convex/service signing/callback credentials and HTTPS app/API origins. It never silently chooses FileStore in production. Termination closes voice work and releases fences with a10second shutdown bound.
- **Cost admission:** Convex atomic owner/global meters bound model requests, speech characters, microphone PCM duration and ingestion bytes. Preview limits are additionally capped at10model calls,5000speech characters,120000transcription milliseconds and30MiB ingestion per UTC day. These are application caps, not a provider-balance claim.

## Credentials and configuration

Ignored `.tokai/cloud/*.env` files hold separate preview/production service RSA keys, session secrets, callback secrets and Better Auth secrets. Production and preview use independent deploy keys. Existing explicitly authorized Gemini/AssemblyAI credentials are installed only in Vercel server configuration. No provider key is sent to Convex or placed in `NEXT_PUBLIC_*` variables.

| Destination | Variable names |
| --- | --- |
| Next.js build | `NEXT_PUBLIC_API_URL=/`, `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL` |
| Vercel API | `CONVEX_URL`, `CONVEX_SITE_URL`, `TOKAI_SERVICE_PRIVATE_KEY`, `TOKAI_SERVICE_KEY_ID`, `TOKAI_SERVICE_ISSUER`, `TOKAI_JOB_SECRET`, `SESSION_SECRET`, `TOKAI_NATIVE_AUTH`, `APP_ORIGIN`, `API_ORIGIN`, `API_PUBLIC_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_VOICE_ID`, `VERCEL_SUPPORT_LARGE_FUNCTIONS`, optional metrics/rate table |
| Convex | Public `TOKAI_SERVICE_JWKS`, `TOKAI_SERVICE_ISSUER`, `TOKAI_JOB_SECRET`, `INTERNAL_API_URL`, `BETTER_AUTH_SECRET`, `APP_ORIGIN`, admission overrides, optional `VERCEL_AUTOMATION_BYPASS_SECRET` |
| Release tooling | Environment-specific `CONVEX_DEPLOY_KEY`; CLI account credentials remain in their existing credential stores |

The project has a scoped automation bypass for its protected preview callback/tests. The fixed callback sends `x-vercel-protection-bypass` **and** `X-Tokai-Job-Secret`. Deployment protection remains enabled. Never put either secret in a URL or print API responses containing bypass maps. [Protection bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

`infra/deploy/prepare-environment.ts` creates ignored credential files without overwriting existing settings. `configure-vercel-env.ts` sends values to the official CLI through stdin, suppresses raw responses and keeps secret values out of shell arguments. `configure-bypass.ts` registers the scoped callback/test capability. `scripts/check-secrets.ts` compares tracked/staged content against both local and generated cloud credential values entirely in memory.

Do not run `convex deployment select` or `--save-env` without an explicit custom file: that would overwrite local development selection. Every cloud command uses an exact deployment selector or the separate ignored deploy-key file.

## Accounts

Native accounts use the maintained Convex Better Auth component, with the existing OIDC integration preserved. Email/password registration and sign-in work without a third hosted identity account. Emails are explicitly unverified; password recovery is unavailable until a real email delivery callback is configured. The system never auto-links identities by email. Explicit guest claim cancels active owner work before moving data, quotas and sessions.

Current compatible pins are `@convex-dev/better-auth0.12.7` and `better-auth1.6.34`. The current upstream vulnerability audit includes advisories for optional flows; the release uses an explicit HTTP capability allowlist and regression tests for disabled routes rather than an unsupported1.7.x component combination. This is a documented scoped exception, **not a claim that the pinned library has no advisories**. Only password signup/signin/signout, session and Convex token/JWKS discovery endpoints are enabled. Magic-link, social/Generic OAuth/OAuth Proxy, device authorization, password recovery and passkeys are not enabled. Recheck component compatibility and advisories before changing these capabilities. [Convex integration](https://labs.convex.dev/better-auth/framework-guides/next), [Better Auth password behavior](https://better-auth.com/docs/authentication/email-password).

## Release procedure

1. Pass local typecheck, unit, build, browser, real Convex ownership/storage/auth/voice tests and the secret scan. Commit and push Phase6 first. Preserve the commit ID as the release source.
2. Deploy the frozen Convex functions/schema to **staging only** using its deploy-key file. Do not import local data. The equivalent production push occurs only after preview verification.
3. Deploy Vercel Preview from that commit. The web service build runs typecheck and isolated unit tests before asset checks/Next build. Its test environment removes cloud/provider credentials, service origins, VERCEL flags and integration opt-ins; actual build/runtime retains the deployment settings. The API service produces its Linux native bundle.
4. Assign the stable preview alias configured above. Confirm Next.js/API origins, Convex CORS/auth baseURL and callback origin all match that alias. Authenticate preview automation through the header/cookie bypass, keeping it out of trace attachments and request logs.
5. Complete the hosted checks below. Only then push the same Convex source to release and create/promote the matching Vercel production build. Record immutable Vercel deployment IDs and the commit.
6. Connect Vercel Git integration if the existing GitHub App permits it. Otherwise the authorized CLI deployment plus Vercel-native build gates is the working release workflow. Do not add GitHub Actions or block the initial hosting proof solely on optional Git integration.

Example deployment commands after the release gate:

```powershell
pnpm exec convex deploy --env-file .tokai/cloud/preview-deploy.env --typecheck enable --codegen disable
pnpm exec vercel deploy --scope avinash1286s-projects
# Assign the returned immutable deployment to the configured preview alias.
pnpm exec vercel alias set <preview-deployment-url> tokai-preview-avinash1286s-projects.vercel.app --scope avinash1286s-projects
```

Use the same explicit environment selection for production; never rely on the local default Convex target. Future schema changes must remain backward-compatible with the prior application deployment until promotion and rollback windows end. [Deployment promotion](https://vercel.com/docs/deployments/promoting-a-deployment), [Git integration](https://vercel.com/docs/git).

## Evidence and remaining hosted gates

Local completed checks include actual6MiB private Convex upload/download integrity; real native account/session/guest-claim/deletion; and two Fastify API instances sharing real Convex tickets/fences. The cross-instance voice test proves APIA ticket→APIB upgrade, reuse rejection, durable board state before event publication, playback completion,1012rotation and authoritative reconnect without audio replay. Provider calls in that test are injected fixtures, not live AI.

The traced Windows bundle contains268files and417,655,690bytes including fonts. A guarded actual OCR+384dimension embedding probe passed without resolving dependencies outside the bundle; the latest warm local run reported roughly314MB peak RSS. The VERCEL-path Unicode PDF test passed against packaged fonts. **These results do not prove Linux deployment execution, cold-start latency or hosted memory usage.**

Required on the actual preview:

- Health, sample lesson, board/model interactions and enforcing CSP; actual native signup, guest claim, logout/login and deletion of only the isolated verification account.
- A transfer larger than4.5MB, a small scanned PDF job through the scheduled authenticated callback, actual384dimension retrieval, and a PDF export using the packaged fonts; record Linux memory/cold/warm timing.
- Actual WebSocket upgrade, single-use ticket rejection and a connection across the platform lifetime with planned rotation/reconnect. Verify no stale audio/visual commit and no replay.
- One bounded live Gemini turn and one brief AssemblyAI output using existing free account credentials, with no automatic retry or model upgrade. Keep this evidence separate from fixture tests.
- Stale/revoked identity and deletion/worker races, quota denial, protected preview callback authentication, and cleanup of the isolated probe's private data.

If the account's current Beta/runtime limits prevent a complete free deployment, record the exact platform failure and preserve the working local implementation. Do not silently remove voice/native processing or purchase another hosting destination.
