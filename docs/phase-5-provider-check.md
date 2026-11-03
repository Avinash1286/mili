# Live teaching verification, 2026-11-03

The locally configured Gemini tutor passed an explicitly opted-in structured teaching probe on the existing account. No model setting, billing setting, paid fallback, or account tier was changed. The probe used a temporary lesson in memory and did not persist a learner session or request speech.

Exactly three application-level model requests were made in this diagnostic run:

1. Default 25-second application budget: `TUTOR_FAILED`, no accepted tool call or HTTP status exposed by the original probe.
2. Same budget after adding safe error metadata: provider HTTP **504**, `ApiError`, before any accepted tool call.
3. Explicit 45-second bounded budget: **passed**, in **36,954 ms**. One model request returned `draw_shapes` and `submit_teaching_beat`; one teaching beat and four board commands passed the real server validation. There were zero repairs, rejected tools, warnings, or text-only fallbacks.

An additional offline test used the real installed Google GenAI SDK with intercepted `fetch`, confirming that all seven tool declarations serialize and that a fixture diagram becomes validated board commands. That test made no network request. The SDK was inspected: absent `retryOptions`, its transport makes a single HTTP attempt; no SDK retry budget was enabled by the application.

The provider now defaults to a bounded 45-second request and accepts an optional server-only `limits.requestTimeoutMs`, clamped to 1–45 seconds. Structured learning generation uses the same 45-second upper bound. SDK timeout errors map to a safe timeout message. The probe exposes elapsed time, safe error category/name and numeric HTTP status, without printing prompts, generated prose, tool arguments, credentials or raw provider messages.

Reproduction requires another explicitly authorized request:

```powershell
pnpm exec tsx scripts/verify-teaching.ts --live --timeout=45000
```

Without flags, the script makes no provider request. This diagnostic's three-call allowance is exhausted; no further automatic probe was made.

This result establishes actual provider access and accepted visual tool output for one small photosynthesis process diagram. It does not establish free-form teaching accuracy, rubric quality, browser rendering, audible speech/visual synchronization, or a latency target. Observed latency was approximately 37 seconds, which remains substantially slower than a conversational tutoring target. Local app outer deadlines must exceed the chosen provider budget if that slow response is to complete; a passing fixture cannot establish faster live performance.

Primary implementation references: [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output), and [Generate Content thinking controls](https://ai.google.dev/gemini-api/docs/generate-content/thinking). The configured Flash-Lite model's documented default minimal thinking was retained; no unsupported thinking setting was added.
