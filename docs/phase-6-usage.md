# Work limits, measurements and optional estimates

Every expensive operation reserves work in Convex before contacting a provider or starting source processing. The owner and deployment-wide checks commit in the same mutation. A new guest cannot bypass the shared deployment limit, and separate API instances share concurrency reservations. Prepared sample replies and saved material do not consume model units.

| Work | Per owner/day | Shared/day | Owner/shared concurrency | Unit |
| --- | ---: | ---: | --- | --- |
| Model | 100 | 400 | 1 / 4 | Actual requests, with up to3 reserved for a teaching turn |
| Speech synthesis | 30,000 | 120,000 | 1 / 4 | Unicode characters |
| Transcription | 1,800,000 | 7,200,000 | 1 / 4 | Audio milliseconds |
| Source processing | 50MiB | 200MiB | 1 / 2 | Source bytes |

Configure `TOKAI_<KIND>_DAILY_UNITS`, `_GLOBAL_DAILY_UNITS`, `_CONCURRENCY` and `_GLOBAL_CONCURRENCY` on **Convex**, where admission is authoritative. Kinds are `MODEL`, `SPEECH`, `TRANSCRIPTION`, `INGESTION`. Values are bounded integers; zero disables that category. Isolated FileStore tests use the API environment and a process-local ledger; that adapter is not the production quota mechanism.

Successful work settles once and releases unused reserved units. Failed or timed-out work retains its reservation because a missing response does not prove the provider did no work. Expired leases free concurrency; they do not refund unknown usage. Transcription input is bounded to the admitted audio amount before sending PCM. Quota failures are explicit and do not switch to a paid provider. These are application limits, **not proof that an account cannot incur a charge**; actual account credit rules and billing remain with the provider.

Background jobs encountering busy capacity wait60 seconds before their second attempt and120 before their third, so a normal bounded tutor turn has time to release its reservation. They stop after three attempts. Exhausted daily allowance fails visibly without immediate automated retries. Other transient executor failures retain the shorter bounded retry schedule. A failed item remains available for an explicit retry.

`GET /v1/me/usage` returns the current UTC day's totals, remaining owner allowance, running work and reset time. `GET /v1/sessions/:id/usage` returns the same day's measurements attributed to an owned saved lesson; its remaining allowance still reflects the whole owner. New-lesson planning/introduction occurs before a saved lesson exists and appears only in owner totals. Sources processed independently of a lesson are also owner-level work. Deletion closes access immediately and retention sweeps remove owner-scoped measurements; global aggregate counters contain no lesson content.

Actual Gemini metadata records model/request identifiers and available token fields. Missing token counts stay unknown. Speech and transcription record available PCM duration; characters are the bounded application work unit, not a claim about an invoice's billing minimum. `TOKAI_LOG_METRICS=1` emits structured work IDs, safe provider request IDs, durations and numeric observations. It excludes prompt, source, transcript, key and audio contents. This is metadata logging, not an installed external tracing/error-monitoring service.

## Optional dated USD estimates

Set API-only `TOKAI_USAGE_RATES_JSON` to a strict JSON object with these fields:

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
  ingestionPerGiB?: number
}
```

Supply verified USD rates for your own account. No example price is shipped as a default, and no pricing is configured on the current local account. Zero is accepted only when explicitly supplied, such as a known local processing rate.

Estimates are calculated when a work result is observed and stored with the effective date, so later configuration changes do not reprice earlier results. Model estimates require the exact reported model ID and sufficient consistent metadata; cached input is deducted from ordinary input, and output includes reported reasoning tokens. Unknown models, failed requests, absent required counts and unsupported tool-use tariffs remain unpriced. Speech uses successful character work; transcription requires observed audio duration. Missing or invalid measurements are never treated as free work.

The displayed total is a **partial estimate of measured, priced work**. It excludes unknown work, storage, network egress, provider minimums, discounts and taxes. It is not a credit balance, invoice or hard dollar-spend limit. The deployment's resource reservations provide the admission bounds even when pricing is absent. Provider dashboards remain the source for account balances and charges.

## Measured local concurrency

`pnpm verify:capacity` uses actual loopback Convex and real HTTP with prepared sample replies; it sends no model or speech requests. The November4 local run completed60 turns across4 learners and72 successful HTTP requests in9,202ms, with p50441ms, p95613ms and p99703ms. Cross-owner access returned404. Peak sampled API RSS was238,399,488bytes. The run exposed and verified a fix for responding before the outer Convex creation transaction committed.

This short probe is not live-provider throughput, long-session WebSocket capacity, acoustic latency or hosted Linux memory evidence. The separately measured Windows OCR/embedding child probe used a peak320,937,984bytes RSS and2,628ms. Hosted native execution requires its own deployment check.
