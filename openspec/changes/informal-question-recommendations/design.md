# Design

## Context

This follows the archived `question-auto-answer` change. Its timer, hold,
setting, shared contracts, and client rendering already ship. Only the
recommendation detector and its coverage change here. See proposal.md for
motivation and the delta spec for the behavior contract.

## Goals / Non-Goals

Keep detection deterministic and local, with one source of truth for deadline
eligibility and displayed answers. No new timers, persistence, model calls,
free-text answers, or Codex auto-answer support.

## Decisions

**D1 — Recommendation detection is a pure function beside `parseQuestions`.**
`recommendedAnswers(questions): Record<string, ChatQuestionAnswer> | null`
returns null unless every question has at least one explicitly recommended
option. Match each option's label and description independently using these
bounded rules (no model call, general fuzzy matching, or inference from the
question text, preview, or surrounding transcript):

- Normalize case and collapse whitespace for detection only. Parentheses,
  square brackets, Markdown emphasis, and punctuation may surround a marker.
- Recognize the exact phrases `recommended`, `I recommend this`,
  `I recomend this`, and `my recommendation`. `recomend` is the explicitly
  supported typo; arbitrary misspellings are not inferred.
- A phrase qualifies when it occupies an entire field, is a leading marker
  followed by punctuation and explanation, or is a trailing annotation
  separated from preceding option text by brackets or a dash/colon that starts
  the field or follows whitespace, so a hyphen inside a word
  (`Least-recommended`) is prose, never an annotation. Thus
  `A (Recommended)`, `A — My recommendation`, `[MY RECOMMENDATION]`, and a
  description `I recommend this. It is easier to maintain.` qualify.
  A bare word inside prose, such as `Uses the recommended settings`, or a
  phrase embedded in `Review my recommendation` does not qualify. The old
  trailing `(Recommended)` convention remains supported; an annotation in
  the middle of an otherwise unmarked field does not qualify.
- A field that negates or disclaims the recommendation does not supply a
  positive match: `Not recommended`, `I do not recommend this`,
  `I don't recommend this`, `I never recommend this`, and
  `This is not my recommendation` are negative cases. A hyphen or dash joins
  `not`/`non` to the phrase just like a space (`not-recommended`,
  `non-recommended`). If either field
  explicitly negates a recommendation of this option, exclude that option
  even if its other field has a positive marker; do not resolve conflicting
  signals by field order. Implement this as bounded negative phrase rules,
  not a claim to understand arbitrary natural language.

Single-select takes the first matching option in input order, multi-select
every matching option, with one selection per option even when both fields
match. Labels are returned verbatim so `validateAnswers` accepts them;
normalization never changes displayed or submitted labels. Missing or
non-string descriptions provide no signal. An unmarked question still
prevents a deadline for the entire request.
Alternative — treat the first option as recommended when none is marked:
rejected, the tool convention makes "first" a style hint, not a decision.

**D2 — Preserve the existing timer pipeline.** `recommendedAnswers` remains
its input. No second parser is added to the driver or client. The production
manager test replaces only the process-timer boundary; driver construction,
setting conversion, input parsing, detection, and settlement remain real.
A hand-built driver alone is insufficient to verify that wiring.

## Acceptance oracles

The previous change's deadline state machine and QA-P1/P2/P4 remain unchanged.
This change adds no recovery mechanism or exclusive slot; model-based recovery
tests are inapplicable. Existing tests continue to guard user-answer, hold,
cancellation, setting, and Claude-only behavior.

### Recommendation detection examples

Each row assumes a positive wait and that every other question is marked.
These fixtures complement QA-P3; they do not change the timer state machine.

| Oracle id | Input | Observable result |
|---|---|---|
| QA-R1 | Label `A (Recommended)`, `A — My recommendation`, or description `I recommend this. It is easier to maintain.` | Option qualifies; the request gets a deadline and answers with the original label |
| QA-R2 | Label or description `I recomend this`, `[MY RECOMMENDATION]`, or `  I   recommend this!  ` | The supported typo, casing, wrappers, whitespace, and punctuation qualify |
| QA-R3 | `Not recommended`, `I do not recommend this`, `I don't recommend this`, `I never recommend this`, or `This is not my recommendation`; also label `A (Recommended)` with description `Not recommended` | Option does not qualify; if it is the only candidate in a question, no deadline exists |
| QA-R4 | `Review my recommendation`, `Uses the recommended settings`, `A (Recommended) only in a different situation`, or no marker; a marker only in question text or preview | No recommendation inferred; if a question has no other candidate, the whole request waits |
| QA-R5 | Multiple options qualify through mixed label and description markers, including an option with both fields matching | Single-select takes the first in input order, multi-select takes all once each; labels remain verbatim |
| QA-R6 | A description-only recommendation through the production manager/driver composition | Countdown payload and timer answer contain the original option label, the timeout marker and agent note appear, and a hold still prevents settlement |

### Eligibility invariant

QA-P3: a live timer and deadline payload exist iff every question has a
qualifying option and the wait is positive, in a Claude chat. Use the existing
manual clock and public driver inputs; seed 20261024, 300 cases over 1–3
questions, single/multi-select, 0–4 options, independent labeled fixtures in
labels/descriptions, and wait zero/positive. Expected outcomes come from
fixture classifications, not the implementation's regex. Zero-option inputs
are rejected by the existing parser and cannot produce a deadline.

### Hazard review and evidence

Consulted `docs/oracle-hazards.md`: M1 is guarded by QA-R6 through manager
construction; the derived-state hazard is guarded by leaving one detector
for both displayed and submitted answers. Evidence map:

| Oracle | Test / fixture | Mutant killed |
|---|---|---|
| QA-R1, QA-R2 | `recommendedAnswers.test.ts` › `informal recommendation grammar (QA-R1–QA-R5)`; fixture titles are exact JSON inputs from `fixtures/recommendationCases.ts` | Drop description, phrase, typo, or punctuation matching |
| QA-R3, QA-R4 | Same independently classified negative fixtures; `question text and non-string descriptions never supply a signal` | Accept negative, conflicting, incidental, or unrelated-field signals |
| QA-R5 | `mixed fields preserve input order, original labels, and one selection per option` | Normalize answer labels, reorder selections, or duplicate an option matching both fields |
| QA-P3 | `chatQuestionAutoAnswerProperties.test.ts` › `QA-P3: a deadline exists iff a full recommendation and a positive wait (300 seeded cases)` | Arm a timer without full eligibility |
| QA-R6 | `chatSessionManagerQuestionAutoAnswer.test.ts` › `description-only recommendations time out with original labels and a hold prevents settlement (QA-R6)` | Leave suffix-only gating in production, submit description text, or ignore a hold |

## Risks / Trade-offs

- [Incidental prose resembles a recommendation] → bounded annotation positions,
  explicit negative precedence, and independent negative fixtures.
- [An unseen phrase remains unmatched] → keep the request waiting; expand the
  supported grammar through another explicit specification change.
- [A hyphen inside a negation reads as an annotation separator] → dash-like
  suffix separators require the field start or preceding whitespace, and
  hyphen/dash-joined `not`/`non` phrases veto either field (B1 fixtures).

## Migration Plan

No migration. The next question uses the broader detector. Pending deadlines
keep their captured answers. Rollback restores the previous detector.
