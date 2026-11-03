# Pinned local MediaPipe assets

The JavaScript and all six WASM support files come from the exact installed
`@mediapipe/tasks-vision@1.2.0` package. The task model comes from Google's
versioned `float16/1` URL. The application requests these files from its own
origin; there is no runtime CDN/latest-version dependency.

After `pnpm install --frozen-lockfile`, verify the current files without
network requests:

    pnpm exec tsx scripts/sync-mediapipe-assets.ts --check

Restore the exact pinned files from the installed package and official model
and license URLs:

    pnpm exec tsx scripts/sync-mediapipe-assets.ts --sync

Sync checks downloaded bytes before replacing a destination and rejects any
version, checksum, size or source mismatch. It does not regenerate trusted
hashes from new downloads. An upgrade requires an explicit review of the
package version, all identities, model compatibility and licensing evidence.
The package tarball integrity is enforced by pnpm's lockfile; the manifest
also records it for auditability.

`LICENSE-APACHE-2.0.txt` preserves the complete upstream runtime license.
`NOTICE.txt` is an original provenance explanation, not an upstream notice.
The task model's weight-license field remains `NOASSERTION`: the inspected
official model card and component BUILD file do not establish an explicit
redistribution grant for this exact bundle. Integrity checks do not resolve
that rights question. Do not describe all assets here as MIT or imply the
runtime package license automatically covers the model weights.

The external task weights are ignored by Git. Run `pnpm assets:sync` after a fresh clone to download them directly from the pinned official source for local use.
