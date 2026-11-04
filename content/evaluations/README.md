# Versioned learning evaluation corpus

`learning-v1.ts` contains 64 fixed cases across photosynthesis, fractions, the solar system and simple circuits: 16 per subject. It includes 48 assessment turns, covering all 32 authored questions and all five answer types, and 16 interaction/semantic-boundary cases. There are 40 development cases and 24 labeled holdout cases. Expectations and rationales are explicit data; the runner does not derive expected answers from the grader result.

The holdout labels were fixed before the first run. The corpus is public, authored alongside the implementation, and has already been run; it is not a blinded external benchmark. Future prompt changes should use development cases first and record holdout results separately. Add a new version rather than quietly changing an expectation to make a regression pass. A corrected source ID in the initial authoring pass is reflected in the reported corpus hash.

Run from the repository root:

```powershell
pnpm exec tsx scripts/evaluate-learning.ts --split=development
pnpm exec tsx scripts/evaluate-learning.ts --split=holdout
pnpm exec tsx scripts/evaluate-learning.ts --report
```

The final command writes the full report to `var/probes/learning-evaluation-all.json`. Every run prints an outcome summary and fails with a nonzero exit code if any expectation fails. The report includes source-audit status, the fixed evaluation clock, case IDs, per-topic and per-split results, and SHA-256 fingerprints of the corpus, authored packs and runner. There is no live mode, credential loading, API request or model call. An HTTP `fetch` guard fails if a future change accidentally attempts network work.

The runner executes the real assessment/evidence engine, public assessment projection, mastery reducer, sample teaching planner, teaching proposal validator, semantic layout/reducer, selection resolver and voice event schemas. Tests include equivalent numbers and units, exact tolerance boundaries, wrong/partial answers, unavailable free-form grading, assistance evidence, stale/missing/ambiguous selection, invalid references, preservation of student work, unsafe graph input, blank transcripts, explicit interrupt commands, sample scope disclosure and untrusted grading instructions.

`source-audit.ts` records a dated agent review of primary publisher/institution pages. It is not a human subject-matter review. Eleven URLs were accessible and checked for the stated narrow factual support. The NCBI Bookshelf URL presented an access challenge and is marked accordingly; the corpus uses accessible OpenStax support for the tested chloroplast claims. Existing pack source IDs and URLs must match this manifest, and every case's factual source must have checked status. The runner does not re-fetch pages and cannot establish their future availability.

Passing means the fixed engine and boundary expectations are satisfied. It does not measure Gemini answer quality, accent/noise robustness, speech intelligibility, teaching appropriateness or learning gains. See `docs/phase-6-evaluation.md` for the separate human and audio review protocol and honest current evidence.
