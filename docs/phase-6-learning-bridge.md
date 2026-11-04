# Tutor practice and provider usage

The Phase 6 tutor can stage three durable learning actions: present an existing assessment, evaluate an explicitly submitted answer, or queue review-card generation. A turn can contain at most one learning action. These actions use the same questions, assistance history, immutable attempts, evaluations, mastery rules and background jobs as the Practice and Study pack interfaces.

## Trusted boundary

- `ask_question` accepts only an assessment ID and version from the server's public catalog. It cannot create an answer key. Source-only lessons do not inherit authored questions from a similarly named sample topic.
- The application supplies the stored question's narration and display text, replacing the model's proposed practice narration. Long questions retain their full text in the practice panel.
- `evaluate_answer` accepts only a presentation ID. The answer comes from an explicit `practiceResponse` submitted by the learner, or the final transcript captured in an explicitly selected answering mode. Ordinary conversation is never graded. Structured answers remain available when spoken choice/numeric/diagram input is ambiguous.
- Explicit answers run the stored evaluator before the tutor model admission step, and produce canonical feedback without requiring another tutor model call. Free-form rubric grading remains bounded to one separate request; unavailable or inconsistent grading yields uncertainty, not success.
- `generate_flashcards` queues the existing durable artifact job. Narration says queued, not ready.

`prepareLearningTurn` performs validation and any bounded grading before publication. Its `finalize` function canonicalizes the accepted reply and attaches a server-only `commitLearning` callback. The HTTP/voice owner executes that callback inside its existing session transaction and cancellation/epoch fence, immediately before committing the associated teaching beat. The callback stages resources and mutates the supplied session; only the caller saves the session. An interrupted future beat therefore creates no question, attempt, evidence or card job. An already committed question remains accessible even if its narration was interrupted; persistence is not a claim that it was heard.

The action receipt uses a stable session/turn key. Repeated commits cannot duplicate presentations, attempts or jobs. Submission checks include the assessment version, presentation resource revision, current help history, owner, parent session and existing attempt. Assistance and same-day answer exposure are preserved. The `session.practice` field is a public projection of the authoritative presentation/attempt resources; opening the tutor question does not create another presentation.

The browser's structured-answer route pauses live voice before opening the saved question. Bounded dictation in that form remains a real spoken-answer alternative. The continuous voice protocol also supports explicit presentation binding; that transport capability does not imply an additional surfaced microphone mode.

## Actual usage metadata

Gemini tutor, image explanation and learning-generation adapters accept `onUsage`. Each actual SDK request reports one allowlisted observation: provider/model, documented response ID when present, and the actual prompt/candidate/cache/thought/tool-use/total token counts supplied by the provider. Cache tokens are already part of prompt tokens; these fields must not be added as independent billable totals. Missing counts, failed requests and aborted requests remain unknown. A late response after cancellation cannot report a second observation. Metadata sinks cannot change the learner-facing response.

No prompt, answer, source passage, generated output, credential or raw provider error is included. The response ID is a provider trace identifier, not a fabricated HTTP request header. The application admission meter is separate from the provider account's invoice and balance.

Plans, rubric grading when actually needed, card regeneration, artifact assessment/card generation, recap speech and review speech all enter the shared admission meter. Single-call generation adapters reserve one model request. Speech uses Unicode codepoint counts for the actual trimmed text; recap additionally reports its measured PCM duration. Deterministic questions and local exports make no model calls. Before a custom lesson exists, planning intentionally omits a session trace because there is no owned persisted session yet. HTTP generation combines the client-disconnect signal with its deadline; jobs retain their own cancellation signal.

## Verification boundary

Focused tests cover canonical question text, no private answer keys in the catalog, strict rejection of model-authored answers/scores, one action per turn, no learning tools without a trusted server context, delayed persistence, interrupted future beats, duplicate commit receipts, same-day assistance, actual answer binding, changed help during grading, source-only isolation, owner isolation, durable card jobs, conservative text parsing and actual metadata aggregation. SDK tests intercept requests locally; no live provider calls are made by these tests. Full HTTP/voice/browser and Convex gates are tracked separately in the Phase 6 testing record.

Provider metadata semantics: [Gemini GenerateContent API](https://aistudio.google.com/api-reference/generate-content). This implementation does not interpret those counts as a billing estimate.
