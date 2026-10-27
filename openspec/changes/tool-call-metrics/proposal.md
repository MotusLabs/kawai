# Proposal

## Why

Tool calls fail in ways nobody sees until someone reads transcripts by hand.
- A project using Kawai found, after the fact, that every coverage submission took 3 to 6 refusals, and that one model gave up (`coverage-tool-usability`).
- This machine's own chat-wire logs show the same pattern: 48 `Input validation error` refusals on `task_submit_result`, about 30 each on `task_note` and `send_message`, and Codex `Invalid arguments for echo` calls from collapsed MCP emission.

Kawai already records each tool call as an observation (`src/server/metrics/observations/chatTracker.ts`). It keeps only a broad category (`shell`/`file`/`mcp`/`other`) and success or failure. It keeps no tool name and no failure reason, it exports nothing to Prometheus, and the Metrics tab does not show it. A tool whose schema or wording misleads agents therefore stays invisible, and nobody can show that a fix such as `coverage-tool-usability` worked.

## What Changes

- **Tool identity and failure class on every tool observation.**
  - Each `tool` observation gains a bounded tool name:
    - the CLI's built-in tool names;
    - each `kawai-team` tool by its own name, the same for Claude (`mcp__kawai-team__x`) and Codex (`kawai-team` namespace) calls;
    - `mcp:other` for any other MCP tool;
    - `other` for anything else.
  - A failed result gains a failure class, read from the result text by a pure classifier:
    - `input-invalid`: the runtime's schema validation;
    - `refused`: a `kawai-team` handler's refusal;
    - `precondition`: the CLI's `<tool_use_error>` checks, such as "File has not been read yet";
    - `blocked`: the harness blocked the call;
    - `unavailable`: no such tool;
    - `denied`: the approval was denied;
    - `command-failed`: Bash and Monitor non-zero results;
    - `other`.
  - The text itself is never stored, as today.
- **Failure streaks.** Consecutive failed results of the same tool in one session's turn form a streak. A success of that tool closes it as `recovered` with its length. The turn's end closes it as `abandoned`. A restart closes it as `unknown`. Each closed streak is a durable fact kept 90 days.
- **Prometheus export** (when `/metrics` is enabled):
  - `kawai_agent_tool_calls_total` by team, group, provider, model, tool, outcome, and failure class;
  - `kawai_agent_tool_failure_streaks_total` by the same identity, tool, and resolution;
  - `kawai_agent_tool_failure_streak_length`, a histogram of streak lengths.
  - The operations doc gains example alert rules for an abandoned-streak rate and a per-tool `input-invalid` share.
- **A Tools family in process metrics.** It is computed at read time for a 1d, 3d, or 7d window with the usual `n`, baseline, and sufficiency rules, and sliceable by profile or group:
  - tool failure rate, broken down by tool and failure class;
  - first-attempt success rate of `kawai-team` tools;
  - abandoned streaks;
  - mean failures before recovery.
  - Drill-down lists the window's abandoned and longest streaks. Each one opens its chat at the first failed call.
  - `team_metrics` returns the family like every other.

## Capabilities

### New Capabilities
- `tool-call-metrics`: how tool calls are identified, how failures are classified, how failure streaks are found, and how both are recorded and exported.

### Modified Capabilities
- `team-process-metrics`: adds the Tools family and its drill-down to the Metrics tab and to `team_metrics`.

## Impact

- `src/server/metrics/observations/chatTracker.ts`: tool name, failure class, and streak state per live turn.
- A new pure `toolCalls.ts` beside it holding the name bounding, the classifier, and the streak reducer.
- `store.ts`: retention for the new `tool_streak` fact kind.
- `src/server/metrics/export/registry.ts`, `accumulator.ts`, `boundedLabels.ts`: three families, plus bounded `tool`, `failure_class`, and `resolution` labels.
- `src/shared/processMetrics.ts`, `src/server/metrics/computeMetrics.ts`, `metricsQuery.ts`: the Tools family, read from observations in the same read transaction.
- Client: the Metrics tab renders the new family. The drill-down sets `chatStore.pendingReveal` to `tool:<callId>`.
- `docs/operations/process-observability.md`: the families, labels, and alert examples.
- No database migration: observations are kind-tagged JSON rows. No wire-protocol change beyond the snapshot's added family. Builds on `process-observability`'s observation store, whose code is on master.
- Out of scope:
  - storing tool inputs or outputs;
  - a per-tool schema version;
  - attention items or automatic changes in response to a metric.
