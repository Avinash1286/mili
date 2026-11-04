# Local backup, restore and job recovery

Tokai uses a persistent native Convex backend locally. FileStore tests are not evidence that Convex data or native files can be restored.

## Repeat the isolated verification

Keep the main backend on ports 3210/3211 running. From `F:\mili`, run:

```powershell
pnpm exec tsx scripts/verify-restore.ts
```

The script requires unused ports 3212/3213. It refuses to stop an occupant, and never starts a second backend on 3210. Each run creates a fresh directory under ignored `.tokai/restore-probe/<timestamp>/`, initializes an anonymous native instance with the official pinned Convex CLI, verifies its independent credentials and database location, and stops only its own backend when finished. Successful and failed run directories remain available for local inspection; the script does not recursively delete directories.

The main deployment permits only an official `convex export --include-file-storage` operation in this script. Imports are guarded to the isolated port 3212 URL and fresh destination. The copied application code includes Better Auth, but disables cron execution in this probe and sets its executor URL to an unused loopback port, so copied jobs cannot reach the main API or call a provider. The main watcher and data remain in place.

Verification performs these real native operations:

1. Export the main tables, component tables and native file storage into a ZIP archive.
2. Deploy copied application code to the empty isolated instance; separately restore the necessary environment settings.
3. Import the archive using the official CLI, then export it again.
4. Compare canonical hashes of every exported table's full documents, including ownership fields, IDs and component data. Compare each exported native file's byte hash. ZIP container hashes may differ because archive metadata changes; document/file hashes are the comparison.
5. Create one file only in the isolated backend, export it, physically delete its native bytes, import its backup and compare its restored byte hash. This is required even when the main snapshot contains no files, so storage verification is not vacuous.
6. Exercise missing job timers, expired and active worker leases, completed work, exhausted retries, deleted owners, stale-worker publication and repeated recovery against the real isolated Convex scheduler.
7. Run retention against separate isolated fixture owners: an expired guest, expired credentials, an old retained session, its private child resource, events and session usage ledger. Check that aggregate owner usage remains available, expired raw files are removed, active files and still-consented indexed text remain, and current file inventory follows actual deletion.

Only stages, counts, hashes and Boolean checks are printed. `report.json`, raw private backup archives, isolated credentials, command logs and copied backend code remain under the ignored run directory. The generated fixture functions are deployed only inside that directory, never to the application backend. These archives contain private application/authentication data and belong in access-controlled backup storage; `.gitignore` is not encryption.

## Operational backup and restore

For an ordinary local backup, run the official CLI from the configured application directory:

```powershell
pnpm exec convex export --include-file-storage --path .tokai/backups/manual-snapshot.zip
```

Use an unused filename. Record the application commit, lockfile and backend version alongside the archive. Keep the matching server environment and identity configuration separately protected. Convex exports omit code, environment variables and scheduled functions. That means the ZIP alone is insufficient to start the application or recover outstanding job timers. Better Auth component tables are included in the full export; do not restrict restoration to root tables.

Restore into a fresh, isolated backend first. Deploy the matching code and schema, set its service/JWKS/authentication environment, and keep its executor disconnected until data verification finishes. Run `convex import <archive.zip>` against that explicitly selected destination, with `--include-file-storage` on the original export. `--replace-all --yes` is destructive and is used by the verification script only inside its isolated file-loss fixture; it is not a suggested command for the active database.

Before a real cutover, stop the previous API/executor and point the replacement API at the restored backend. Verify owner-isolated session reads, private downloads and login with the restored environment. Then enable the executor and run the internal `recovery:sweep` mutation once, or allow its one-minute cron to run. Old restored active leases are allowed to expire; they are never stolen while valid. Keep the original archive and deployment intact until application verification is complete.

## Recovery behavior

`convex/recovery.ts` scans at most 50 job documents in each mutation, using a durable paginated continuation. It checks the owner, parent session and target resource before rescheduling. Existing pending/in-progress scheduler records are preserved; missing scheduler records are rebuilt from application outbox data. Completed jobs are never replayed. A valid running lease is left alone. An expired running lease is changed to pending and its fence is incremented before a new timer is created, so its previous worker cannot publish. Workers still need the normal atomic `assertJob` publication guard.

Deleted parents cancel outstanding work. Three exhausted attempts produce a failed job and, when the expected resource revision still matches, a failed source/artifact that the learner can retry. Recovery does not reset attempts, bypass ownership or invent successful completion. Repeating the sweep preserves the same newly created timer. The cron is registered separately in `convex/crons.ts`.

## Evidence and limits

Native execution on November 4, 2026 (Nepal time; latest report timestamp `2026-11-03T19:48:41.967Z`) restored 631 records across 30 tables, including 12 Better Auth component tables and the new storage inventory table, with matching canonical document hashes. That main snapshot contained zero stored files; a separate isolated native file was exported, deleted and restored with matching bytes. All nine job-recovery checks and all thirteen retention checks passed, including deletion of a retained lesson's private usage ledger, expired raw-file removal, active-file preservation, exact remaining owner inventory, deleted-owner inventory cleanup and preservation of aggregate counters. The run's `report.json` is authoritative for counts, since other local integration tests can change the next snapshot's record count.

This verifies local native restore mechanics and application recovery behavior. It does not establish off-machine disaster recovery, an encrypted backup destination, a production hosting SLA, provider retry quality or a cloud deployment. No model or speech provider requests are made by the probe.

Official references: [Convex Backup & Restore](https://docs.convex.dev/database/backup-restore), [Data Import](https://docs.convex.dev/database/import-export/import), [Scheduled Functions](https://docs.convex.dev/scheduling/scheduled-functions), [Local Deployments](https://docs.convex.dev/cli/local-deployments).
