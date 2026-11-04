# Native authentication dependency review

Reviewed 2026-11-04. This is a **restricted-configuration dependency exception**, not a clean dependency audit or an upstream vulnerability fix. `pnpm audit --prod` still reports the following advisories for the pinned Better Auth version. No audit suppression, unsupported upgrade, or cryptographic backport was applied.

The application pins `better-auth@1.6.34` and `@convex-dev/better-auth@0.12.7`. Registry metadata checked with `pnpm view` reports Better Auth 1.7.15 as latest, but the latest Convex adapter 0.12.7 requires `better-auth >=1.6.11 <1.7.0`. Consequently there is currently no latest-release pair satisfying the adapter's declared compatibility and all three advisory fixes. Recheck [the adapter's published metadata](https://registry.npmjs.org/@convex-dev/better-auth/0.12.7) and [Better Auth's metadata](https://registry.npmjs.org/better-auth/1.7.15) before changing these pins.

| Advisory | Upstream severity and prerequisite | Current application reachability |
| --- | --- | --- |
| [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm) | Critical; OAuth database state can collide with Magic Link verification when both Magic Link and social/Generic OAuth are enabled. Fixed in 1.7.7. | Magic Link and Generic OAuth plugins are absent; no social providers are configured. Their endpoints are additionally blocked by the native request allowlist. |
| [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm) | High; opt-in device authorization does not expose sufficient client/permission context for approval. Fixed in 1.7.0-rc.3. | Device authorization is not installed in the plugin configuration; all device endpoints are blocked. |
| [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf) | High; OAuth Proxy ciphertext can be reused in another OAuth purpose under the affected proxy/key/state configuration. Fixed in 1.7.7. | OAuth Proxy is absent, social flows are absent, account linking is disabled, and callback/proxy endpoints are blocked. |

The package contains optional plugin code; absence above means **not enabled or routed in this application**, not absent from the installed tarball. Native password sign-in uses `better-auth/minimal` with only the Convex plugin. The separate Fastify OIDC bridge uses its own validated provider flow; it does not enable Better Auth social, Generic OAuth, or OAuth Proxy plugins.

## Enforced surface

`convex/native_auth_policy.ts` allows only these exact method/path pairs, before invoking the Better Auth HTTP handler:

- POST `sign-up/email`, `sign-in/email`, `sign-out` under `/api/auth/`.
- GET `get-session`, `convex/token`, `convex/jwks`, and `convex/.well-known/openid-configuration` under `/api/auth/`.

The adapter's root OpenID discovery redirect remains available. All other auth HTTP paths, including dynamic OAuth callbacks, return 404 without issuing a cookie. The configuration assertion fails if a plugin other than the single Convex plugin is added, social providers are enabled, or account linking is enabled. This guard must not be expanded until the dependency review is repeated. It also intentionally blocks unused Better Auth default account-management endpoints; Tokai's existing owner-authorized account deletion uses the server-side component adapter.

## Why an upstream backport was not selected

The [upstream purpose-isolation fix](https://github.com/better-auth/better-auth/commit/ac54bfd67821a7607533af2059858b12bc54e26a) spans state storage, strict Magic Link record parsing, a new HKDF key derivation module, and multiple OAuth Proxy encryption paths. The [device authorization fix](https://github.com/better-auth/better-auth/commit/f68044dcfbd9fb83763249ed9509cfacbcce47be) changes request/resource semantics and persisted schema. These are not an isolated one-line fix against the adapter-supported 1.6 build. Maintaining an unverified private cryptographic/schema backport for disabled functionality would require a separate compatibility and upstream regression effort. [The 1.7.7 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.7) confirms the purpose-isolation fix shipped and explains pending-flow invalidation.

## Verification and removal criteria

`packages/db/test/native-auth-policy.test.ts` checks the frozen capability configuration and request boundary, including encoded/trailing path variants. `packages/db/test/native-auth-policy.integration.test.ts` calls the actual local native backend: disabled flow endpoints must return 404 without cookies, while session and JWT discovery remain usable. Both policy unit tests and the native endpoint test passed on 2026-11-04 after deployment of the guard. Run with `TOKAI_TEST_CONVEX=1`; the test does not invoke an external identity provider or print credentials. Existing native signup/sign-in/token/revocation/deletion integration remains the positive authentication coverage.

The platform's `native-auth.integration.test` also passed against the final guard (14.4 seconds), covering real registration, JWT/session binding, sign-out, sign-in again, and scheduled credential/session cleanup after deletion of its isolated test account. No external identity or model provider was called.

Review this exception again by 2026-11-11, immediately on a new adapter release, or before any authentication capability change, whichever comes first. Remove it only after installing a supported fixed version pair and rerunning native account lifecycle, guest claim, session ownership, cookie/origin, revocation and dependency checks. Do not describe the dependency scan as clean while these advisory matches remain.
