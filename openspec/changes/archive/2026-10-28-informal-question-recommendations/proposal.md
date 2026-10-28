# Proposal

## Why

The archived `question-auto-answer` feature only recognizes a trailing
`(Recommended)` label. Agents also recommend an option through wording such
as `I recommend this`, `I recomend this`, or `My recommendation`, leaving
otherwise eligible questions waiting indefinitely.

## What Changes

- Detect explicit recommendation markers in option labels or descriptions,
  with bounded positions and case, whitespace, emphasis, and punctuation
  normalization.
- Exclude negated, conflicting, and incidental mentions. Keep original labels,
  the every-question eligibility rule, and single/multi-select ordering.
- Extend independent fixtures, seeded deadline checks, production manager
  coverage, and documentation. Existing waits, holds, settlement, and Claude-only
  scope remain unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: broaden recommendation detection for the existing timeout.

## Impact

`src/server/chat/contentBlocks.ts`, recommendation and deadline tests, and
`AGENTS.md`. No API, database, or dependency changes. This is a follow-up to
`archive/2026-10-24-question-auto-answer`; the archived artifacts remain intact.
