# Design

## Context

See proposal.md for motivation. `ChatView` uses `ChatMessages` for both active and archived Chats. `SessionPreviewContent` separately renders terminal history with author/time metadata and grouped content. Borrow that visual pattern without coupling SDK Chat events to terminal log parsing.

`ChatEvent.at` already carries an ISO timestamp. `applyChatEvents` currently replaces an assistant entry with each delta/final event, including its timestamp. `transcriptReplay.ts` substitutes the current time when a historical row has no timestamp. These details were harmless while Chat did not show times, but need correction for trustworthy visible metadata.

`ChatHeader` currently reserves one non-wrapping line for profile, model, project, task, and parked state. `useHeaderLayout` measures the header in chat-font ems and compacts Team/context at fixed width steps. The durable header spec still describes the old panel switcher; `team-workspace-pages` supplies the Team-button behavior already present in source.

## Goals / Non-Goals

**Goals:** Keep one renderer and event model for live/replayed Chat; make responsiveness follow the content container and font size; preserve existing detail components and keyboard behavior.

**Non-Goals:** Rework terminal history, change message routing or agent execution, add a display-mode setting, introduce a UI dependency, or implement the separate Codex provider change.

## Decisions

### D1. A shared metadata/body layout around existing content

Use a small Chat transcript row primitive with metadata and body slots. On wide containers it forms an em-sized metadata gutter plus a `minmax(0, 1fr)` body. On narrow containers it stacks metadata above the body. Use the transcript container's inline size, rather than viewport width, so opening Debug also triggers reflow. Preserve the chat font setting.

Remove asymmetric user/assistant margins. Give user, assistant, and peer bodies the same alignment. The user body keeps a quiet surface inside the shared body column, so the existing chat contrast requirement still applies to it, and gutter author/time text meets the same 4.5:1 secondary-text contrast. Keep authors explicit: You, the session's agent identity (Claude today, taken from the session's agent kind), and the existing linked peer participant. Never derive the provider from a model string. Allow author labels to wrap.

Terms: a *message* is one SDK message id within a turn; a *text block* is one transcript entry of that message (see D5). Use a quiet divider at author changes and larger separation at turn boundaries. Turn boundaries come from `turn_started`, user, and peer events (replay yields no `turn_completed`; turn ends live in `chat_turn_ends`), so live and archived Chats separate turns the same way. Same-author continuations — later text blocks or messages of the same turn — use tighter spacing but remain separate semantic articles with their own metadata. Tool and system rows align with the body column. They break visual continuation when appropriate; no reordering or combining distinct event payloads. Stable React keys preserve expanded details during streaming.

Alternative: reuse the terminal preview parser and components directly. Rejected because Chat has richer structured events and interactive controls. Alternative: keep bubbles and add timestamps above them. Rejected because it misses the agreed aligned archive-style reading flow.

### D2. Show recorded times, preserving the first content time

Use a shared formatter rendering `<time dateTime>` with a short local clock value and an accessible full local date/time including timezone; expose the full value on hover. A day change gets a small date separator so multi-day transcripts remain understandable without hovering. The separator compares a row with the previous *dated* row, so an undated row neither creates nor suppresses one. Invalid/missing times render no clock and never an Invalid Date string.

For a streaming text block, retain the earliest valid content event `at` of its entry when updating its text; finalization must retain that start. Live, that is the first delta's time. Reconnecting without a server restart restores the server's in-memory events, so the live start survives. Replay (after a restart, or an archived Chat) only has transcript record timestamps, which the CLI writes when it records a block rather than when streaming began: replay uses the earliest record timestamp of that entry, which can trail the live start by the block's streaming time. Displayed times are therefore recorded facts from their source, not identical across live and replay. Audit the live producer, replay mapper, and normalized store together so reconnect does not replace start time with a finalization or attach time. Preserve original log timestamps; no new database table is required.

For historical rows lacking a valid time, stop synthesizing `now` as their message time. `ChatEventBase.at` stays a string; an empty value is its documented "unknown" form (update the field's doc comment), and every time consumer reads it through one shared `validTime()` helper that returns a date or nothing. Audit the consumers that read `at` today: request entries copied into `pendingRequests`, replay's synthesized cancelled-request events (which copy their tool call's `at`), and any elapsed, grouping, or separator logic this change adds. Generated current notices such as history-unavailable keep their actual creation time.

Alternative: format every replacement event's `at`. Rejected because the clock would move while the response grows. Alternative: infer missing historical dates from neighboring messages. Rejected because it would present guesses as recorded facts.

### D3. Preserve content renderers and live affordances

Keep tool call/result pairing and existing tool, worker, and background-task components; change their positioning rather than replacing their behavior. Continue rendering every existing event type. Keep peer context, thread disclosures, revision/handoff notices, origin, tags, duplicate warnings, and participant links intact. Preserve request cards, activity visibility, completion summaries, failure styling, and composer behavior. Use an explicit fixture matrix in validation to prevent losing uncommon rows while restyling.

Archived and active Chats share the new layout; existing archive checks continue to suppress interactive request and Stop controls. Nested worker transcripts use the same row pattern and switch to stacked metadata when their own container is narrow.

Alternative: flatten less common events into a generic log row. Rejected because it could obscure meaningful information and task controls.

### D4. Header hierarchy with wrapping content

Organize `ChatHeader` into:

1. Identity/actions: status and editable name, Team, labelled Auto-approve for live sessions, and session menu. Give the name flexible space; on very narrow headers the action group reflows below identity rather than compressing it to nothing.
2. Supporting metadata: profile, reported model, project basename, and context usage. Let individual fields wrap and break long tokens. Put context at the trailing edge when it fits, otherwise on its own line. Retain full path on hover and expose it accessibly.
3. Task/paused context when present: a distinct wrapping row with the full task label and readable parked reason. Keep task navigation, spawned provenance, and existing status semantics.

Retain container-width and font-aware Team compaction, but recalibrate its thresholds for the actual action group rather than the former multi-panel switcher. Compaction exists to keep identity and actions on one row at common widths: the thresholds measure that row, and moving the action group below identity is the fallback for very narrow headers and large fonts once Team has already folded into the menu. Context compaction must consider its metadata row, not force identity to shrink. Full counts remain in an accessible description when only percentage is shown. Let CSS wrapping handle content length; width breakpoints alone cannot predict task titles. Do not add a user-facing expand-header mode.

Usage and notification strips remain below the header. Retain Switch and session-menu behavior, kill confirmation, inline rename, and archive/restore restrictions. The header delta supersedes the two-line restriction, while preserving `team-workspace-pages` navigation. If the Codex change lands first, preserve its provider-aware identity without adding a second metadata layout.

Alternative: shrink all labels or hide metadata behind a menu. Rejected because the agreed goal is readable information. Alternative: force a fixed three-row height. Rejected because long labels and larger fonts still need natural wrapping.

### D5. One transcript entry per text block, in order

Today `applyChatEvents` keeps one assistant entry per `(turnId, messageId)`, and an `assistant_text` replaces that entry's text. The CLI emits each content block of one SDK message separately with the same id, live and in the transcript, so a response shaped text → tool → text collapses: the later text overwrites the earlier entry and is drawn in the earlier position, before its tool call. That breaks the order and separate-article layout this change promises.

Fix the store rule: an assistant event merges into the newest entry with its `(turnId, messageId)` only when no other transcript event follows that entry; otherwise it starts a new entry. Deltas and the final text of one block still merge; text after a tool call becomes its own entry, in order, with its own start time (D2). Live and replay share the rule because both feed `applyChatEvents`. Entry keys stay stable (the first event id of each entry) so expanded details survive streaming.

Limitation: two adjacent text blocks with nothing between them still merge, because events carry no block index; neither the final assistant frames nor transcript records expose a global one. This is rare (thinking blocks are not surfaced) and loses no order.

Alternative: add a block index to assistant events. Rejected for now: the per-block assistant frames and transcript lines carry no index to source it from.

## Risks / Trade-offs

- Live and replayed start times can differ by a block's streaming time -> document the source of each (D2); never adjust one to match the other.
- Adjacent text blocks of one message still merge (D5) -> accepted; order is preserved and nothing is hidden.

- Taller headers reduce transcript height when task or paused context is long -> omit absent rows, keep spacing compact, and validate the worst case at small widths.
- A gutter reduces body width -> stack metadata based on the actual transcript container, including nested worker transcripts and Debug layouts.
- Replayed and live message boundaries may differ -> verify producer, store normalization, and replay with one response fixture before relying on displayed times; never invent a missing historical timestamp.
- Rare event information can disappear during restyling -> use a rich mixed-event fixture covering the current renderer and live request/worker/task components.
- Two active changes touch header identity/navigation -> implement after or reconcile with `team-workspace-pages`; preserve provider identity if `codex-chat-sessions` has landed. Archive this header delta after the earlier header delta to avoid restoring the two-line restriction.

## Migration Plan

This is a client layout change plus timestamp normalization/replay corrections and the store's text-block merge rule (D5). No database migration or new dependency is planned. Ship transcript and header together after component, browser, and required repository checks pass. Rollback restores the prior components, styles, and timestamp normalization without modifying stored conversations.
