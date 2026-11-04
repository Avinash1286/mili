# Work limits, measurements and optional estimates

Every expensive operation reserves work in Convex before contacting a provider or starting source processing. The owner and deployment-wide checks commit in the same mutation. A new guest cannot bypass the shared deployment limit, and separate API instances share concurrency reservations. Prepared sample replies and saved material do not consume model units.

| Work | Per owner/day | Shared/day | Owner/shared concurrency | Unit |
| --- | ---: | ---: | --- | --- |
| Model | 100 | 400 | 1 / 4 | Actual requests, with up to3 reserved for a teaching turn |
| Speech synthesis | 30,000 | 120,000 | 1 / 4 | Unicode characters |
| Transcription | 1,800,000 | 7,200,000 | 1 / 4 | Audio milliseconds |
| Source processing | 50MiB | 200MiB | 1 / 2 | Source bytes |
| Private file writes | 100MiB | 400MiB | 4 / 16 | Bytes written, including replacements |
| Private downloads | 500MiB | 2,000MiB | 4 / 16 | Bytes prepared for a transfer |

Configure `TOKAI_<KIND>_DAILY_UNITS`, `_GLOBAL_DAILY_UNITS`, `_CONCURRENCY` and `_GLOBAL_CONCURRENCY` on **Convex**, where admission is authoritative. Kinds are `MODEL`, `SPEECH`, `TRANSCRIPTION`, `INGESTION`, `STORAGE`, `EGRESS`. Values are bounded integers; zero disables that category. Isolated FileStore tests use the API environment and a process-local ledger; that adapter is not the production quota mechanism.

Successful work settles once and releases unused reserved units. Failed or timed-out work retains its reservation because a missing response does not prove the provider did no work. Expired leases free concurrency; they do not refund unknown usage. Transcription input is bounded to the admitted audio amount before sending PCM. Quota failures are explicit and do not switch to a paid provider. These are application limits, **not proof that an account cannot incur a charge**; actual account credit rules and billing remain with the provider.

Background jobs encountering busy capacity wait60 seconds before their second attempt and120 before their third, so a normal bounded tutor turn has time to release its reservation. They stop after three attempts. Exhausted daily allowance fails visibly without immediate automated retries. Other transient executor failures retain the shorter bounded retry schedule. A failed item remains available for an explicit retry.

`GET /v1/me/usage` returns the current UTC day's totals, remaining owner allowance, running work and reset time. `GET /v1/sessions/:id/usage` returns the same day's measurements attributed to an owned saved lesson; its remaining allowance still reflects the whole owner. New-lesson planning/introduction occurs before a saved lesson exists and appears only in owner totals. Sources processed independently of a lesson are also owner-level work. Deletion closes access immediately and retention sweeps remove owner-scoped measurements; global aggregate counters contain no lesson content.

Actual Gemini metadata records model/request identifiers and available token fields. Missing token counts stay unknown. Speech and transcription record available PCM duration; characters are the bounded application work unit, not a claim about an invoice's billing minimum. `TOKAI_LOG_METRICS=1` emits structured work IDs, safe provider request IDs, durations and numeric observations. It excludes prompt, source, transcript, key and audio contents. This is metadata logging, not an installed external tracing/error-monitoring service.

## Optional dated USD estimates

Set `TOKAI_USAGE_RATES_JSON` on **Convex** for authoritative admission and settlement, and use the same dated table on the API for its immediate metadata estimates. This strict JSON object has these fields:

```typescript
{
  effectiveDate: "YYYY-MM-DD",
  models: {
    "exact-provider-model-id": {
      inputPerMillion: number,
      outputPerMillion: number,
      cachedInputPerMillion?: number
    }
  },
  speechPerMillionCharacters?: number,
  transcriptionPerHour?: number,
  ingestionPerGiB?: number,
  storagePerGiBDay?: number,
  egressPerGiB?: number
}
```

Supply verified USD rates for your own account. No example price is shipped as a default, and no pricing is configured on the current local account. Zero is accepted only when explicitly supplied, such as a known local processing rate.

Estimates are calculated when a work result is observed and stored with the effective date, so later configuration changes do not reprice earlier results. Model estimates require the exact reported model ID and sufficient consistent metadata; cached input is deducted from ordinary input, and output includes reported reasoning tokens. Unknown models, failed requests, absent required counts and unsupported tool-use tariffs remain unpriced. Speech uses successful character work; transcription requires observed audio duration. Missing or invalid measurements are never treated as free work.

The displayed total is a **partial estimate under the configured tariff**. Private-file storage is a commitment for its complete bounded retention horizon; egress describes bytes prepared by the application, not proof the recipient received them. Unknown work, provider minimums, discounts, taxes, existing hosting commitments, database metadata, static website traffic and network traffic outside these metered private-file paths are excluded. It is not a provider credit balance or invoice. Provider dashboards remain the source for actual account charges.

## Optional atomic dollar admission

`TOKAI_OWNER_DAILY_USD` and `TOKAI_GLOBAL_DAILY_USD` enable an additional dollar commitment cap on **Convex**. Either may be configured independently. Values are decimal USD strings with at most six decimal places; zero rejects any positive commitment. Both default to unset. The application does not activate prices, enable billing or invent free-account rates.

Every applicable reservation compares both monetary limits and the existing unit/concurrency limits in one Convex mutation. Money is recorded as integer micro-USD, rounded upward. Concurrent API instances cannot spend the same remaining allowance. Admission reserves the maximum commitment before work, and a successful result refunds only the difference supported by complete consistent measurements. Failure, cancellation with uncertain provider execution, missing counts or changed model identity retains the full bound. Settlement is idempotent; guest claim moves private rows and pending settlements without recounting deployment totals. Deletion does not refund already incurred global commitments. A new UTC day starts a new admission ledger.

For models, the API performs a bounded authenticated [Google model metadata lookup](https://aistudio.google.com/api-reference/models) only when a monetary cap requires it. It verifies the exact requested model name, reads its actual `inputTokenLimit` and `outputTokenLimit`, and caches these for at most four minutes. The fixed Google origin, disabled redirects, ten-second deadline and 64KiB body bound prevent arbitrary metadata fetching. The service-authenticated API supplies this proof to Convex, which requires a matching proof no older than five minutes. It reserves full input capability plus full output capability using the greater ordinary/cached input tariff, multiplied by the maximum possible model calls. This deliberately conservative bound covers image input and tool-loop rounds without guessing image tokens. Model aliases whose metadata resolves to a different name fail closed; configure the verified exact model name and corresponding rate. An unavailable lookup or absent rate prevents generation. Ordinary tests inject this lookup and make no provider request.

Speech, transcription and ingestion use their already-enforced character/audio/byte maxima. Operators must supply verified conservative tariffs for the actual account/model/voice and account for applicable billing rules; application tariff caps are not a guarantee about a third party's invoice. Unknown tariffs fail closed when a cap is configured. Enabling a cap after unbounded work already happened that UTC day also fails closed until the next reset, rather than silently treating earlier work as free.

Storage additionally requires `TOKAI_STORAGE_MAX_RETENTION_DAYS` (integer1..365) and `storagePerGiBDay`. Its complete horizon is reserved at write time. The stored expiry is no later than that configured horizon, the learner's retention choice, or guest expiry. Reads reject expired files and maintenance removes their bytes. The UI exposes raw-file expiry; a shorter operator raw-file horizon does not itself erase already indexed source text, which remains governed by learner retention/deletion. Without an enforceable horizon, dollar-capped storage is rejected. With caps and horizon unset, existing retention behavior remains unchanged. Deleting a file reduces the current byte/object inventory; it does not claim a refund from a provider or reverse historical write commitments.

Private uploads reserve before accepting bytes; downloads reserve before reading/preparing the complete bounded response. Download failures retain the reservation when the outcome is uncertain. Both one-use direct transfers and server-side native object operations share the same Convex ledger. Ownership is derived from the source/artifact parent, and is rechecked before publication/delivery. `usage_migration:backfill` attributes legacy private files and populates inventory in atomic pages of50 without changing bytes; repeating it does not double-count.

`UsageSummary.budget` exposes owner/global limits, used commitments and remaining amounts with `basis: conservative-reservations`; `storage` reports current private-file bytes and object count. These totals intentionally distinguish historic work, active conservative commitments and current file occupancy.

Run `pnpm verify:usage` for the isolated native proof. It starts a fresh anonymous backend on3216/3217, creates only fixture owners/files, configures synthetic rates only there, then stops its own backend. On November4 (latest report `2026-11-03T19:48:01.481Z`), the probe verified concurrent global dollar admission, a distinct owner-limit rejection, exact one-time settlement, conservative unknown failure, claim preservation, native inventory, metered private download, cross-owner denial, deletion without global refund and missing-rate rejection. It made zero provider requests and did not read/change the main application's environment or usage limits. The report is kept in ignored `.tokai/usage-probe`.

The separate native database suite passed11 cases after these changes, including uploading as a guest, claiming the workspace, reading the same bytes as the account, rejection of the old guest, migration of inventory without changing global totals, preservation of the original expiry and410 for an expired download. The updated restore probe passed13 retention checks with actual active/expired native blobs. These are local native tests, not hosted billing measurements.

## Measured local concurrency

`pnpm verify:capacity` uses actual loopback Convex and real HTTP with prepared sample replies; it sends no model or speech requests. The November4 local run completed60 turns across4 learners and72 successful HTTP requests in9,202ms, with p50441ms, p95613ms and p99703ms. Cross-owner access returned404. Peak sampled API RSS was238,399,488bytes. The run exposed and verified a fix for responding before the outer Convex creation transaction committed.

This short probe is not live-provider throughput, long-session WebSocket capacity, acoustic latency or hosted Linux memory evidence. The separately measured Windows OCR/embedding child probe used a peak320,937,984bytes RSS and2,628ms. Hosted native execution requires its own deployment check.
