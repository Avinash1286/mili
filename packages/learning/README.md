# Learning engine

This package is pure TypeScript. It performs no network requests, database writes or provider calls. `@tokai/learning` is a **server entry point** because it exports the authored packs and their hidden answer keys. Browser code may import `@tokai/learning/browser`, which only exposes due-card filtering and text/CSV/JSON exporters; that entry point never imports lesson content.

The server must owner-scope every supplied record and atomically persist attempts, evaluations, evidence, review receipts and schedule changes. The engine does not authenticate owners. All returned records are cloned and recursively frozen. Server timestamps must be explicit UTC strings.

## Assessments

- `getLessonPack(topicId, version?)` returns an authored pack or `undefined`; custom live lessons must not substitute an unrelated seed pack.
- `projectAssessment(definition)` returns only visible prompt/options/diagram/target IDs and hint count. Never serialize the full definition before submission.
- `createPresentation`, `applyAssistance`, and `evaluateAttempt` bind grading to an exact assessment version. Help is recorded through server-owned events; a client cannot submit an `assisted:false` flag. When an immediate retry follows revealed answers, the API must carry that assistance into its new presentation. An independently spaced new problem may use a new unassisted presentation.
- Numbers support bounded decimal/scientific notation and simple integer fractions. Magnitude is limited to `10^12`; scientific exponents to −12…12; decimal input to 18 significant input digits. Nothing is evaluated as code. Unit aliases and rational scale factors are explicit. Absolute/relative tolerance boundaries use rational comparisons, avoiding floating-point epsilon widening. Units are case-sensitive (`mA` differs from `MA`).
- Choice and label answers are deterministic. Free text only matches a complete stored reference/contradiction exactly; isolated keywords never establish correctness. All other explanations use an injected `RubricGrader`. Criterion IDs must match, supporting quotes must occur in the answer, low-confidence/inconsistent results stay uncertain, and no unavailable grader is represented as live AI.
- `reviseEvaluation` appends a correction linked by `supersedesEvaluationId`. Store it and invalidate old evidence using `invalidateMasteryEvidence`; retain the immutable original attempt. Regenerate affected cards/study packs in the application job layer.

`tokai-mastery-v1` exposes qualitative states, not numerical ability scores. Unknown/uncertain or invalidated evidence does not imply understanding. Duplicate observations, retries of the same attempt, and repeated questions on one UTC day cannot accumulate support. Demonstrated understanding requires at least three recent independent successes across at least two questions and two UTC days. Assistance alone never reaches that state. A recent wrong answer prompts review; support older than 30 days becomes stale. This is a transparent initial policy, not a validated psychometric model.

## Cards and review

`instantiatePackCards` marks covered-concept versus lesson-reference provenance. `reviseCard` increments the content revision and resets the schedule after content changes; cloze edits require their explicit omission fields. `mergeDuplicateCards` only merges matching kind/prompt/answer/concepts/specialized metadata, retains conservative existing scheduling, and marks other IDs as merged. Marked-incorrect or discarded cards cannot be reviewed.

`tokai-review-v1` is a deterministic initial scheduler, not FSRS:

| State | Again | Hard | Good | Easy |
| --- | --- | --- | --- | --- |
| New | Learning, 1 minute | Learning, 5 minutes | Learning step 1, 10 minutes | Review, 4 days |
| Learning | Step 0, 1 minute | Same step, 5 minutes | Step 0 → 1 in 10 minutes; step 1 → review in at least 1 day | Review in at least 4 days |
| Review | Relearn in 1 minute; lapse +1 | Interval ×1.2, rounded up | Interval ×2 | Interval ×2.5, rounded up |

Review intervals cap at 365 days. Relearning graduation uses half the previous interval, at least one day. All delays use elapsed UTC time; local timezones only affect presentation. The learner's submitted rating is authoritative; a differing suggested rating is recorded as overridden.

`createReviewReceipt(card, submission, now, existingReceipt?)` checks an existing identical receipt before current revisions, so retrying an already-committed request remains idempotent even after later edits. Reusing an ID for a changed payload fails. Persist the receipt and resulting schedule together under a unique owner/review ID constraint; otherwise simultaneous requests can still race outside this pure function.

## Study packs

`buildStudyPack` accepts an optional authored pack. Custom lessons use actual session objectives/goal and board content, leave missing sources empty, and never invent an authored pack ID. Reference material is explicitly separate from completed narration. Only beats with completed status and positive played milliseconds enter completed spoken summaries; partial beats retain timing/IDs but not their entire unheard text. Assessment evidence, rather than prose or generated cards, determines mastery.

The caller supplies owner-scoped attempts and cards; the builder additionally filters them to the session. Audio recap status starts `not-requested`; background generation must update status truthfully. Markdown escapes embedded HTML and markup. CSV protects formula-leading cells and preserves embedded quotes/newlines. JSON preserves specialized cards and source metadata without spreadsheet transformation.

Run `pnpm --filter @tokai/learning typecheck` and `pnpm --filter @tokai/learning test`. Browser/API authorization and concurrent persistence behavior are tested at their respective boundaries.
