# Design

## Context

At `714cf8da`, `NewSessionModal.tsx:549–552` renders the Session kind selector with Terminal and `Chat` (`value="chat"`). `defaultKind` and the open effect preserve generic/chat and change-section/terminal defaults; submission at line 481 passes `chat` and the selected profile id. The backend resolves runtime from that profile, so no new runtime argument belongs in this change. `docs/claude-session-profiles.md:3` still directs users to Claude chat. Existing `newSessionModal.test.tsx` uses React TestRenderer and drives the actual selector/form, including reopen defaults; extend that harness.

## Goals / Non-Goals

Make the existing three scenarios executable acceptance without changing them. No provider naming policy, catalog, handler, protocol, default, or backend changes.

## Decisions

Change only displayed option text and directly related instructions/descriptions. Add focused tests in a new small `src/client/__tests__/newSessionAgentLabel.test.tsx` rather than grow the existing large test file. Render the real modal with controlled catalogs; fetch doubles must assert requested project path and distinguish groups from profiles. Assert observable option text, selections and callback arguments, not source substrings. A small repository-document assertion may share that file with a first-20-lines `@reads: docs/claude-session-profiles.md` header. Existing tests remain regression evidence.

### Acceptance oracles

All rows below are PLANNED, not run. UI tests use actual rendered options and submission callback; DOC1 reads the opening selection paragraph, not an unrelated occurrence elsewhere.

| ID | Input | Observable outcome | Mutant killed |
| --- | --- | --- | --- |
| UI1 | Generic open, catalog loaded | Session kind options exactly Terminal and AI agent with values terminal/chat; Profile visible | Chat or Claude chat retained; value renamed |
| UI2 | Generic → close → change-section → close → generic | chat, terminal, chat selected; Terminal first-prompt controls remain | stale kind reused or default changed |
| UI3 | Select Claude then Codex profile in separate submissions | Label remains AI agent; callback keeps chat and exact selected profile id; existing runtime-resolution tests retain chosen runtime | profile-dependent label; forced default profile/Claude |
| DOC1 | Opening selection paragraph | Directs user to choose AI agent then Profile | stale Claude chat instruction |

UI1 maps Shared agent session choice; UI3 maps Claude and Codex share the label; UI2 maps Existing entry-point defaults, all under `claude-session-profiles` / The New Session dialog names agent sessions independently of runtime. Add those exact `@covers` annotations directly above the future tests. Future titles are “UI1: agent option has provider-neutral text and preserves its value”, “UI2: reopen defaults follow the entry point”, “UI3: both runtimes keep the label and selected profile”, and “DOC1: opening profile instructions name AI agent”. These are planned titles, not current citations or passing evidence.

Property I1: for seed 0xA16E, 24 generated reopen sequences over generic/change-section and selected Claude/Codex profiles, rendered label stays constant and default follows each open; seam is the real modal and captured callback. Property I2: for the same catalog permutations, callback profile id equals selection and kind remains chat; backend runtime resolution remains covered by existing profile tests. No new dependency. Copy-only work adds no recovery state machine.

## Risks / Trade-offs

A text-only assertion could miss the creation/default regression → pair option assertions with callbacks and reopen transitions. A component test cannot prove browser layout → future implementation also uses the existing disposable browser fixture when UI verification is required; never the live server or `bun run test:e2e` teardown. No browser run is claimed for this planning result.

## Implementation contract

### Acceptance
- A1: The real modal offers exactly AI agent and Terminal while preserving chat/terminal values and all three delta scenarios.
- A2: Opening profile instructions direct users to AI agent and Profile; directly related stale test descriptions are updated.
### Invariants
- I1: Generic and change-section entry-point defaults and reopen behavior remain unchanged.
- I2: Profile selection, runtime resolution, and creation payload behavior remain unchanged.
### Scope
- src/client/components/NewSessionModal.tsx
- src/client/__tests__/newSessionModal.test.tsx
- src/client/__tests__/newSessionAgentLabel.test.tsx
- docs/claude-session-profiles.md
### Verification
- V1: UI1–UI3 and DOC1 automated assertions pass and fail their stated mutants; all three scenarios have exact covers annotations.
- V2: Existing modal and relevant runtime/profile tests, required isolated browser verification, and clean committed full check pass with exact evidence in the result.
### Excluded
- X1: No backend, stored identifier, protocol, catalog, default, or provider policy changes.
