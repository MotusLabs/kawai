# Design

## Context

`ChatObservationTracker` (`src/server/metrics/observations/chatTracker.ts`) reads every managed chat's event stream, Claude and Codex alike: Codex dynamic tools arrive as `mcp__<server>__<tool>` (`codexEvents.ts`).
- On each `tool_call` and `tool_result` it writes a `tool` observation holding `{ category, startedAt, durationSeconds, outcome, partial }`, where category is `shell`/`file`/`mcp`/`other`.
- Live state is checkpointed every 30 s. A restart closes open intervals as partial and records a gap.
- `tool` rows are intra-turn detail, kept 14 days.
- `ExportAccumulator` folds observations into the bounded export totals in the same transaction, but it has no `tool` case, so nothing is exported.
- Process metrics (`computeMetrics.ts`) read team tables at read time and have no tool family.

The result text of a failed call is in the event (`tool_result.output`, `isError`), and the tracker drops it after use. The real failure texts on this machine (chat-wire logs, 798 sessions), with counts:
- `Input validation error: Invalid arguments for tool <name>: …`: Claude SDK MCP schema refusals (48 on `task_submit_result`, 29 on `task_note`, 28 on `send_message`);
- `Invalid arguments for <name>: …`: Codex `codexTools.ts`;
- `<tool_use_error>File has not been read yet…`, `No changes to make…`, `Found N matches…`, `String to replace not found…`: CLI tool preconditions;
- `<tool_use_error>Blocked: …`: the harness blocking a call;
- `<tool_use_error>Unknown skill: …`, and `Tool references removed - tool search not enabled` from the user report: unavailable.

## Goals / Non-Goals

**Goals:**
- Name the tool and the cause of every failed call, bounded, with no text kept.
- Detect an agent repeatedly failing one tool, and whether it got through.
- Show it in Prometheus and in the Metrics tab, by model and profile, with drill-down to the call.

**Non-Goals:**
- Storing inputs or outputs.
- Per-argument diagnostics.
- A tool-schema version label.
- Attention items, alerts sent by Kawai, or automatic changes.
- Subagent (Task) tool calls, which the event stream does not carry.

## Decisions

### D1 — Bounded tool name (`toolName`)

The pure function `toolName(raw)` maps:
- a name in `CLI_TOOL_NAMES`, a constant list of the built-ins (`Bash`, `Monitor`, `Read`, `Edit`, `MultiEdit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, `ToolSearch`, `Skill`, `AskUserQuestion`, `ExitPlanMode`) → itself;
- `mcp__kawai-team__<t>` with `<t>` in the team tool table's names → `<t>`;
- any other `mcp__…` → `mcp:other`;
- else → `other`.

The team tool names come from the same table `teamToolTable` builds from, so a new team tool is named without an edit here. Export bounding (`boundedLabels.ts`) adds `tool` with a cap of 96 values. Overflow collapses to `other` as for the other labels.

### D2 — Failure class (`failureClass`)

The pure function `failureClass(toolName, output, context)`. The first matching row of the classifier table below wins. `context.denied` is true when the call's approval request resolved as a denial in this turn. The tracker already tracks requests; the implementer links them by tool call id, and if the event lacks one, matches the CLI's denial text instead (recorded in 1.1).

The text is read once, inside the tracker's handler, and only the class is written.

### D3 — Streaks (`streakReducer`)

The pure reducer is keyed by `(session, turn, toolName)`, and its state is `{ length, firstCallId, firstAt }`.
- A failed result increments the streak, opening it if needed.
- A success of the same tool closes it `recovered` if open.
- Turn end, interruption, or process end closes every open streak `abandoned`.
- Checkpoint recovery after a restart closes every checkpointed open streak `unknown`.

Calls to other tools do not touch it. A closed streak writes one `tool_streak` fact: `{ tool, length, resolution, firstCallId, firstAt, closedAt }`, with the turn's attribution identity.

The streak state rides the existing 30-second live checkpoint. A restart can therefore lose up to 30 s of failures, so an `unknown` streak's length is a lower bound, and the doc says so.

*Why turn scope?* A turn is the unit the agent acts in, so "gave up" means the turn ended without getting the call through. A retry in a later turn starts a new streak. That later retry is visible as consecutive abandoned and recovered streaks on one session, which the drill-down shows.

### D4 — Storage and retention

`tool` rows gain `tool` and, when failed, `failureClass`. They stay 14-day detail, which is enough for a 7d window plus its 7d baseline. `tool_streak` is a fact kind (90 days). Both are JSON-data observations, so no migration is needed.

### D5 — Export families (registry v2 additions)

| family | type | labels |
|--------|------|--------|
| `agent_tool_calls_total` | counter | team, group, provider, model, tool, outcome (`success`/`failed`), failure_class (`none` on success) |
| `agent_tool_failure_streaks_total` | counter | team, group, provider, model, tool, resolution |
| `agent_tool_failure_streak_length` | histogram, buckets 1, 2, 3, 4, 6, 10, +Inf | team, group, provider, model, tool, resolution |

Only completed results count. A `tool_call` without a result counts nothing, so partial calls are never failures. `measurement_definition_info`'s version bumps. The operations doc adds two example rules:
- `increase(kawai_agent_tool_failure_streaks_total{resolution="abandoned"}[1d]) > 0` per tool;
- `input-invalid` share `> 0.2` over 1d per tool, with at least 10 calls.

### D6 — Tools family in process metrics

`metricsQuery.ts` reads the window's and the baseline's `tool` and `tool_streak` observations for the team in the same read transaction. The metric definitions in `processMetrics.ts` all have `family: 'tools'`, `side: 'turn'`, `role: 'context'`, and `guard: null`:
- `tool_failure_rate`, with a tool × class breakdown;
- `team_tool_first_attempt_success`, per tool (first call of each tool in each turn);
- `tool_streaks_abandoned`;
- `tool_failures_before_recovery`, mean.

The turn side slices by group, profile, and the start-based slices through the observation's agent-start reference. The usual `MIN_SAMPLE` and baseline rules apply.

Drill-down lists the abandoned streaks plus the five longest recovered streaks. Selecting one selects its chat and sets `pendingReveal` to `tool:<firstCallId>`, the transcript anchor that already exists.

## Acceptance oracles

### Classifier table (FC)

`kt` means a `kawai-team` tool name.

| id | tool | output / context | class |
|----|------|------------------|-------|
| FC1 | * | `context.denied` | ? |
| FC2 | * | starts `Input validation error:` | ? |
| FC3 | * | starts `Invalid arguments for ` | ? |
| FC4 | * | `<tool_use_error>Blocked:` | ? |
| FC5 | * | `<tool_use_error>Unknown skill:`, `No such tool available`, `Tool references removed` | ? |
| FC6 | * | other `<tool_use_error>` | ? |
| FC7 | kt | any other failed text | ? |
| FC8 | `Bash`/`Monitor` | any other failed text | ? |
| FC9 | other | any other failed text | ? |
| FC10 | * | success | ? |

Rows FC2 to FC5 are pinned by fixtures copied from real wire-log lines (one per row, secrets and paths replaced). Unreachable: a success with `context.denied`, because a denied call never runs.

### Name table (TN)

| id | raw | name |
|----|-----|------|
| TN1 | `Bash` | ? |
| TN2 | `mcp__kawai-team__task_submit_result` (Claude) | ? |
| TN3 | the same name from a Codex dynamic call | ? |
| TN4 | `mcp__kawai-team__not_a_tool` | ? |
| TN5 | `mcp__docs-search__query` | ? |
| TN6 | `echo` (a collapsed Codex emission) | ? |

### Streak table (ST)

The state is closed (∅) or open with length k. Events are failure of tool T (F), success of T (S), another tool's result (O), turn end (E), and restart recovery (R).

| id | state | event | next | fact written |
|----|-------|-------|------|--------------|
| ST1 | ∅ | F | ? | ? |
| ST2 | open k | F | ? | ? |
| ST3 | open k | S | ? | ? |
| ST4 | ∅ | S | ? | ? |
| ST5 | * | O | ? | ? |
| ST6 | open k | E | ? | ? |
| ST7 | ∅ | E | ? | ? |
| ST8 | open k (checkpointed) | R | ? | ? |
| ST9 | ∅ | R | ? | ? |

**Completeness:** every (state ∈ {∅, open}) × (event ∈ {F, S, O, E, R}) pair matches exactly one row. ST5 covers O for both states.

### Properties

P1 is the streak model.
- **Generator:** seeded (`mulberry32` written in the test, seed `0x7001`, 300 cases) sequences of 1–60 events over 3 tools and 1–4 turns, with F/S/O and turn ends, and a restart inserted at a random checkpoint boundary in 30% of cases.
- **Seam:** the sequence is fed to the real `ChatObservationTracker` through its event entry point and checkpoint/recover seam.
- **Property:** the stored `tool_streak` facts equal those the ST table, run as a reference model, produces over the same sequence. Each `tool` row's class equals `failureClass` of its fixture.

P2 is totals.
- **Generator:** the same sequences.
- **Property:** `agent_tool_calls_total` summed over labels equals the number of results. The streak counters equal the fact counts. Pruning every detail row leaves both unchanged.

## Risks / Trade-offs

- [Runtime error wording changes and FC rows stop matching] → Unmatched failures fall to `refused`/`command-failed`/`other`, never lost. The fixture rows fail visibly when a runtime update changes a pinned prefix, because the fixtures come from captured text and the wire-tap capture test reruns them.
- [Series growth] → The tool label is capped at 96 and the failure-class enum has 9 values. The existing 250k series budget and overflow apply.
- [Turn-scoped streaks undercount cross-turn retries] → This is accepted and documented. The drill-down shows consecutive streaks of one session.
- [Restart loses up to 30 s of failures] → `unknown` streaks are labelled as lower bounds.

## Migration Plan

No schema migration. Observations recorded before the change lack `tool`/`failureClass`. The Tools family reads them as `unrecorded`, counted in `n` only where the field exists, so history before the deploy is not mistaken for zero failures. Export totals start at the deploy.

## Open Questions

- None blocking. A schema-version detail field, to compare a tool before and after a fix like `coverage-tool-usability` by build rather than by date, can follow if date comparison proves too coarse.
