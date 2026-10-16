# Design

## Context

See proposal.md for the reported regression. The user confirmed that typing in a new chat is fast. Inspection of tag `v1.0.0-1769` shows that `ChatView` subscribes to its session draft and owns caret/menu state, so each edit renders its un-memoized `ChatMessages` child. That child pairs tool results, computes row layout and day boundaries, serializes tool input, and renders assistant Markdown for the full history. `chatDayKey` constructs one date formatter per dated message; `ChatTime` constructs two more. The timestamp layout shipped in `v1.0.0-1758` and is present in 1769.

A local Bun microbenchmark of equivalent date formatting measured roughly 101 ms for 500 dated messages with fresh formatters versus 1.2 ms with reused formatters. This measures neither browser input latency nor the full rendering cost; the suspected mechanism still needs browser validation.

The working checkout is older than the deployed layout and has unrelated local edits, including untracked planning for `chat-transcript-layout`. Implementation must start from a baseline containing that shipped code, preserving unrelated work. The existing durable `chat-sessions` spec covers drafts and commands; this change adds a performance contract without replacing those requirements or the layout delta.

## Goals / Non-Goals

**Goals:** Bound the work caused by editing to composer state; reduce repeated formatting and Markdown work during actual transcript updates; prove the separation through deterministic regression checks and browser measurements.

**Non-Goals:** Transcript virtualization or pagination, hiding history, changing the visual layout or event model, a new state library, debouncing typed text, deployment changes, or eliminating every linear pass when new transcript events genuinely arrive.

## Decisions

### D1. Move draft and caret ownership into a composer component

Extract the form, session draft subscription, caret/selection restoration, slash filtering/menu state, and argument hint into `ChatComposer`. Keep the existing per-session Zustand draft store as the source of truth, updated immediately. Pass session identity, connection state, command state, and submit/interrupt callbacks; keep attach/detach, reconnect subscription, and pending `/clear` archival bookkeeping in `ChatView`. Route trimmed submissions through the existing command-aware parent handler. Read live session identity at render time; do not retain stale session ids in callbacks. Reset transient caret/menu state on session switches without discarding stored text.

Memoize `ChatMessages` with normal prop equality and preserve stable props so unrelated parent updates also skip history work. Store-driven worker/task components must continue receiving their own subscriptions. Avoid custom equality that ignores participant names, connection or archive state, event changes, or project path.

Alternative: only memoize `ChatMessages`. This addresses idle keystrokes but leaves composition coupled to the whole view and does not address formatting on real updates. Alternative: debounce or defer draft writes. Rejected because it can delay visible input and complicate immediate submission and session switching.

### D2. Reuse formatters and memoize pure derived work

Replace per-call `Intl.DateTimeFormat` construction in `chatTimeFormat` with reused formatters keyed by effective locale, timezone, and formatting kind. Keep supported explicit-zone test seams; bound caches if arbitrary zone keys are accepted. Resolve browser defaults without making an explicit-zone call change later default-zone behavior. Avoid an unbounded cache keyed by every message timestamp.

Memoize tool pairing and layout by the events reference and the current local day; include explicit timezone when present. Calculate the current day cheaply using the reused formatter; re-evaluate on the next real render so day grouping is not frozen across midnight. Memoize timestamp labels by timestamp and formatting context. Memoize the shared `Markdown` component by its content prop so updates to one message do not reparse older bodies; its CSS continues to inherit theme and font size. Keep stable existing row keys and disclosure DOM identity.

Alternative: formatter reuse alone. It reduces a major constant but still allows full-history work per edit. Alternative: virtualize the transcript now. Deferred because it expands scope to scroll, search anchors, and disclosure behavior before these direct bottlenecks are removed.

### D3. Verify the work avoided and the user-visible result

Extend `src/client/__tests__/chatComponents.test.tsx` or a focused neighboring test with a long mixed history. After mount, type/delete/paste, move the caret, and navigate the slash menu. Use scoped spies or counters to assert that these edits do not trigger transcript layout, history Markdown parsing, or timestamp formatting. Send a real transcript update afterward to prove memoization does not suppress updates. For streaming, assert that changed content is parsed while unchanged Markdown bodies are reused. Verify formatter construction is bounded by formatting contexts rather than row count, with timezone, invalid-time, and day-boundary cases.

Extend existing Playwright chat fixtures and `tests/e2e/chat-drafts.spec.ts`, or add a focused sibling. Use a deterministic synthetic conversation with at least 500 dated message rows containing representative paragraphs, lists, code blocks, and tool calls/results. Compare to an empty chat using real per-character keyboard input, idle and with scheduled output updates (for example, 10 updates/second). Include slash selection, a mid-draft selection, submission, session switches, and an expanded tool disclosure. Confirm actual output arrives and drafts/focus/selection stay correct.

Record browser/build/fixture, sample count, median and p95 input-to-next-paint latency, and traces before/after on the same machine. Proposed diagnostic target: p95 below 50 ms after warmup in the long fixture with no sustained backlog. This is a review target, not a portable wall-clock CI assertion: deterministic work-count checks enforce the regression contract. If browser traces still show history-dependent input blocking, resolve that measured cause before calling the fix complete. Browser verification must use a fresh production bundle rather than an existing `dist/client` from another revision.

## Risks / Trade-offs

- Stale memoized output or participant names -> retain complete prop dependencies and test actual event/name/archive updates.
- Component extraction changes caret, slash-command, or `/clear` behavior -> reuse existing draft and command tests and add switch/reconnect checks.
- Shared formatter defaults or midnight grouping become stale -> key formatting context explicitly, preserve explicit-zone tests, and test day changes on a subsequent render.
- Shared Markdown memoization affects terminal previews -> rerun the existing Markdown rendering suite for both consumers.
- Streaming still requires a linear layout pass over events -> accept that pass for this scope; reuse old message bodies and formatter instances, then inspect the browser trace. Virtualization remains a separate change if later evidence justifies it.
- Hardware-sensitive timing -> compare the same fixture and environment; gate automated regression checks on work avoided and functional outcomes.

## Migration Plan

Implement against a baseline containing the shipped transcript layout, then run focused rendering/browser checks and the required lint, typecheck, and unit suite. Ship as an ordinary client update with no data migration or new setting. Rollback reverts the client optimization without altering drafts' storage contract or conversation records.
