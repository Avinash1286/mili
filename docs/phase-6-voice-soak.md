# Sustained local voice ownership and memory check

The bounded local soak passed on 4 November 2026 (local time). It ran for **180.302 seconds** with three concurrent learners and two independent Fastify API instances, using a fresh native Convex deployment on ports 3214/3215. The API instances and WebSocket clients share one measured Node process. Providers and playback acknowledgements are explicitly synthetic; provider requests were zero.

The deployment used newly generated service keys and empty data, copied the current application functions, disabled background cron work and directed callbacks to an unused local port. It did not import, export, mutate or consume allowances from the main database. Its owned API servers used ephemeral ports. Setup and teardown never stop another process occupying a requested port.

## Recorded result

| Check | Result |
| --- | ---: |
| Connections | 36 |
| Graceful / abrupt / scheduled-rotation closes | 12 / 12 / 12 |
| Completed / interrupted during speech / cancelled during delayed generation | 36 / 36 / 36 |
| Duplicate text requests without duplicate learner turns | 36 |
| Competing connections denied by durable ownership | 36 |
| Released durable fences / rejected stale-fence writes | 36 / 36 |
| Actual timed lease renewals | 12 |
| Silent synthetic microphone PCM packets | 72 |
| Deliberately late audio callbacks after cancellation | 65 |
| Stale audio frames / protocol errors / unhandled errors | 0 / 0 / 0 |
| Sockets, synthesizers, transcribers, tutor calls and provider timers active at end | All 0 |
| Memory samples, every 10 seconds plus endpoints | 20 |
| Retained heap growth after warmup | 1.25 MiB |
| RSS growth after warmup / peak process RSS | 74.20 / 205.57 MiB |

Each cycle issues the voice ticket through the other API instance, checks a fresh epoch and advancing durable fence, rejects a second owner, completes one response, interrupts another, and cancels a delayed tutor result that deliberately ignores its abort signal. It checks that the cancelled diagram never reaches saved state. A completed request is repeated with the same ID to verify deduplication. Capture is then started and paused with synthetic PCM, followed by one of the three disconnect paths. A cross-instance read verifies the exact learner-turn count; an attempted write with the released fence must fail without changing revision. Cross-owner lesson access must return 404.

The soak explicitly configures 12-second rotation and two-second grace, so actual ten-second lease-renewal timers execute. Local automatic rotation is disabled by default in the normal application. No fake clock advances these checks.

Memory uses explicit garbage collection, a 30-second warmup, and at least ten later samples. The retained-heap bound is 64 MiB; the RSS growth bound is 192 MiB with a 768 MiB process peak limit. The recorded values passed these bounds. Saved session history legitimately grows during the run; these bounds are a regression signal, not proof that no allocation can leak.

## Reproduce

Install the workspace dependencies and the native local Convex binary through the normal setup first. Leave ports 3214/3215 available:

```powershell
pnpm exec node --expose-gc --import tsx scripts/verify-voice-soak.ts
```

`scripts/isolated-convex.ts` creates the fresh ignored workspace, copies only code, generates its own credentials and closes its own backend in `finally`. It also supports distinct ports for other isolated native integration checks. Main application credentials and provider keys are not read. The main local backend configuration supplies only its installed backend version.

The aggregate report is written to ignored `var/probes/voice-soak-local.json`. Isolated setup logs, database and private probe credentials remain under ignored `.tokai/voice-soak/`; do not publish that directory. The successful command exited with code 0, removed its probe owners and left no listeners on ports 3214/3215. The tooling TypeScript check passed before execution.

This check does **not** measure browser or physical-device memory, the separate Convex process's memory, real speech recognition/synthesis quality, echo handling, hosted capacity or stability over hours or days. Real provider load and longer production observations require separate evidence. The earlier short HTTP capacity check and browser interruption checks cover different paths and are not replacements for this soak.
