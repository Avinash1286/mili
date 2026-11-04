# Learning and interaction evaluation

On 2026-11-03, the offline `tokai-learning-evaluation-v1` corpus passed **64 of 64 invariant cases**, with **zero model calls and zero HTTP attempts**. Each of the four seed subjects contributed 16 cases. The development split contains 40 cases; the labeled holdout split contains 24. This is a deterministic regression result, not a 100% live tutoring accuracy claim.

The 48 assessment turns cover every authored question, all five assessment types, correct/incorrect/partial/uncertain outcomes, scientific notation and rational equivalents, units, exact tolerance boundaries and assisted evidence. Another 16 cases exercise actual prepared diagrams, canonical selection grounding, stale and ambiguous references, source gaps, invalid map references, student-work protection, executable graph rejection, blank transcript and interrupt contracts, off-topic sample disclosure and answer text attempting to override grading. The report also checks that public assessment projections exclude the answer key and that one answer cannot establish demonstrated mastery.

Reproduce and retain the machine-readable report:

```powershell
pnpm exec tsx scripts/evaluate-learning.ts --report
```

The report is written to `var/probes/learning-evaluation-all.json`, with individual outcomes and corpus/pack/runner hashes. The labeled holdout was fixed before the first run but is public and shares an author with the implementation. It is suitable for detecting regressions, not estimating generalization to unseen learners. Subjective criteria need independent reviewers. The initial execution caught an incomplete evaluation fixture for `input.interrupt`; adding its required `outputEpoch` fixed the fixture without changing production behavior.

## Factual support audit

The dated manifest in `content/evaluations/source-audit.ts` records eleven accessible primary publisher/institution pages and one unavailable page. Source support was checked at the claim level, without copying textbook passages. OpenStax is the publisher of the cited textbooks; NASA is the institutional author of its science material. These are primary publication locations, not a claim that every textbook is original research.

- Photosynthesis: [OpenStax overview](https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis) and [light-dependent reactions](https://openstax.org/books/biology-2e/pages/8-2-the-light-dependent-reactions-of-photosynthesis) support matter/energy roles, thylakoid reactions and the water origin of released oxygen. The [NCBI chapter](https://www.ncbi.nlm.nih.gov/books/NBK26819/) could not be rechecked because the browser showed an access challenge; it is not counted among checked URLs.
- Fractions: [equal parts and notation](https://openstax.org/books/prealgebra-2e/pages/4-1-visualize-fractions), [equivalence](https://openstax.org/books/prealgebra-2e/pages/4-2-multiply-and-divide-fractions) and [common units for addition](https://openstax.org/books/prealgebra-2e/pages/4-5-add-and-subtract-fractions-with-different-denominators) support the original examples.
- Solar system: [NASA planet classification](https://science.nasa.gov/solar-system/planets/), [Earth facts](https://science.nasa.gov/earth/facts/), [rotation/time conventions](https://science.nasa.gov/learn/basics-of-space-flight/chapter2-1/) and [Newtonian mechanics](https://science.nasa.gov/learn/basics-of-space-flight/chapter3-2/) support the tested concepts. The audit corrected the authored gravity citation to the mechanics chapter. The arithmetic exercise explicitly uses exactly 24 hours per day; it does not equate that convention with NASA's 23.9-hour rotation figure.
- Circuits: [current](https://openstax.org/books/college-physics-2e/pages/20-1-current) and [Ohm's law and simple circuits](https://openstax.org/books/college-physics-2e/pages/20-2-ohms-law-resistance-and-simple-circuits) support charge-per-time, voltage, resistance and the stated ohmic examples.

## Live and audio evidence

The separate [bounded provider check](phase-5-provider-check.md) records exactly three Gemini requests, with the third producing a valid diagram in 36,954 ms. That establishes one accepted live teaching turn; it does not establish rubric grading quality, conversational latency targets or correctness across this corpus. The offline runner never spends that request budget again.

The browser fixtures in `tests/fixtures/voice-api.ts` use a quiet synthetic 220 Hz PCM16 tone at 24 kHz, 150 frames of 480 samples (3 seconds), plus deliberate stale/duplicate events. `tests/e2e/voice-loop.spec.ts` exercises real browser capture/playback plumbing, interruption and denied-microphone text fallback. `tests/e2e/teaching-visuals.spec.ts` checks readiness, cancellation and future visual suppression. Product dictation uses another synthetic 220 Hz oscillator with a fixed fixture transcription. These tones are not speech and establish no accent, pronunciation, intelligibility or STT accuracy result. Final browser pass counts belong in the integrated test report.

## Independent review and usability protocol

Human evaluation remains unperformed; no participant consent, external reviewer score or learning gain is fabricated. Before making effectiveness claims, recruit consenting reviewers and learners, record the sample size, explain data retention, and use new transfer questions rather than repeating the teaching example. For each subject, collect a short pre-question, lesson attempt, unaided transfer question and optional usability feedback. Report individual qualitative observations and uncertainty alongside any aggregate.

For each independently captured teaching turn, two reviewers should score factual correctness, source support, question relevance, misconception handling, age/level suitability, verbosity and reference resolution on a 0–2 rubric: 0 means a material failure; 1 means usable with a stated issue; 2 means no issue observed. Record a brief explanation, any disagreement and adjudication. Tool validity and fabricated source IDs are hard failures regardless of a favorable style score. Use the actual played/delivered content, not an unspoken generated script. Preserve uncertain assessments and assisted answers as such.

For audio, build an explicitly consented or licensed synthetic speech set spanning slow/ordinary/fast rates, varied accents, silence, interruptions and measured background-noise conditions. Record provenance, transcript, sample rate, duration, speaking rate, noise mix and consent/license per clip. Score transcript word error rate, false finalization on silence, interruption latency, dropped/duplicated output and human intelligibility. Keep a held-out voice subset. Do not label a sine-wave plumbing test as this experiment, and do not synthesize accent results from fixture transcripts.

These human and speech-quality checks remain release evidence to collect; automated fixtures cannot supply them. Physical-device performance, accessibility with actual assistive technology and user learning outcomes likewise remain distinct from passing the deterministic corpus.
