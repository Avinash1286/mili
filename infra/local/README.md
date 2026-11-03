# Local Convex runtime

Use Node24 and pnpm. From the repository root:

1. Run `pnpm exec convex init` with `CONVEX_AGENT_MODE=anonymous` in the command's environment. This downloads the official native backend and creates the ignored local deployment configuration; no cloud account is needed.
2. Run `pnpm exec tsx infra/local/setup.ts`. It generates a server-only service signing key and callback secret into ignored `.env.local` without overwriting provider settings. It writes only the public JWKS and internal callback configuration to ignored `.tokai/convex.env`.
3. Keep `pnpm exec convex dev --tail-logs disable` running. The database and native storage persist in `.convex/`; the backend stops when this command stops.
4. In a second terminal run `pnpm exec convex env set --from-file .tokai/convex.env`. The watcher deploys the configured service authentication. Only an authenticated Tokai API can call application storage functions.
5. Start the API/web with the root development command. The API loads root `.env` provider settings plus `.env.local` local infrastructure settings. The default Convex URL is `http://127.0.0.1:3210`; HTTP actions use3211.

Do not commit or print `.env.local`, `.tokai/convex.env`, the `.convex` state directory or local admin credentials. Native local deployment is a beta development mode and must stay on the local machine; future Vercel hosting requires a separately configured reachable backend. This setup does not use Convex AI Gateway or change provider billing.

`packages/db` FileStore remains an explicit single-process compatibility/test option. It is not proof of Convex durability. Integration tests require the real local backend and service credentials, and report that distinction.

For local accounts on Windows with Java25 installed, run `powershell -File infra/local/install-identity.ps1`, `pnpm exec tsx infra/local/setup-identity.ts`, then keep `pnpm exec tsx infra/local/start-identity.ts` running. The installer verifies the upstream Keycloak26.8.1 archive SHA256 before extraction. Keycloak listens only on127.0.0.1:8088, stores its development database in ignored workspace data, and permits registration in the isolated tokai-local realm. Generated administrator/client credentials remain in ignored files. This is local development identity, not production hosting.

Before switching an existing checkout from FileStore, stop its API and run `pnpm exec tsx infra/local/import-legacy.ts` for a dry-run. Then run with `--apply`: the script saves a timestamped backup before idempotently importing owner credentials and lessons. It never overwrites existing Convex snapshots/tombstones. `pnpm exec tsx infra/local/verify-import.ts` checks exact imported snapshots without printing lesson contents. Existing guest bearer tokens continue to match their original hashes.
