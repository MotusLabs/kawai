# Proposal

## Why

Kawai runs its own development with agent teams, but nobody can tell whether the process is getting better. A copy of the live database (2026-10-12 to 10-16) shows real friction: the lead sends half of all mail (446 of 886); 8 of 10 review findings are failures and 9 of 15 results are resubmissions; normal mail waits 17.6 minutes on average, 835 at worst; there are 115 profile limit events, 20 parks, and 7 forwards. Meanwhile group prompts change daily (8 commits to `.kawai/groups/` in four days) and shared memory changes with no history. Without measurement, those edits are guesses, and nothing records which prompt a session ran with, so their effect cannot be attributed. The data to measure most of this already sits in kawai's tables. What's missing is per-turn token usage, a record of which prompt and memory each agent started with, and a place where the human and the lead read the same numbers.

## What Changes

- **Per-turn usage records.** Every completed chat turn records its token counts (input, output, cache read, cache creation), steps, group, profile, model, and the task pinned when the turn started (none for task-less work), as tokens without currency. This pulls `plan-supervision` D14 (`chat_turn_usage`) forward and widens it from task-bound turns to all turns, so `plan-supervision` reuses this record instead of defining its own.
- **Agent-start provenance.** Each agent start records a content hash of the group file (role prompt and settings) it loaded, per-file hashes of the shared Claude memory directory it saw, the profile, and the model. Metrics can then be sliced by prompt and memory version.
- **Task status transitions are recorded.** Today a status change overwrites `team_tasks.status` and leaves no trace unless someone writes a journal note, so neither lead time (first `done`) nor reopen rate can be computed; `updated_at` also moves on every revision. Each transition gains an append-only row.
- **Metric inputs are retained long enough.** A 7d window with a 7d baseline needs 14 days of data; limit events are pruned after 24 hours today, so their pruning moves to 15 days (routing still reads only its own 24-hour window).
- **A metrics core.** Pure functions compute a fixed metric set over the existing tables for a window (1d, 3d, or 7d). Values are computed at read time and never stored. Each value carries its sample size `n`, the previous window as a baseline, and an "insufficient sample" flag below a threshold. Each efficiency metric is paired with a guard metric:
  - Flow: task lead time; mail wait (p50/p90). Guard: share of done tasks with an accepted result.
  - Quality: first-pass review yield; fix iterations per task. Guard: reopen rate.
  - Overhead: lead mail share and lead hops per task; friction events (parked, forwarded, uncertain, dead) per task. Guard: reopen rate.
  - Capacity: limit tax (blocked hours per profile); tokens per done task by group and profile. Guard: first-pass yield for the same group and profile.
- **A Metrics tab on the Team page** shows the metric set per window, sliced by group, profile, and prompt version, with drill-down to the tasks and threads behind a number.
- **A `team_metrics` kawai-team tool** returns the same numbers to agents. It is read-only, and agents cannot change metric or guard definitions.
- **Process reports with proposals.** The lead writes 1d, 3d, and 7d reports, scheduled to itself, as kawai-owned rows. Window roles are fixed: 1d is operational (no prompt or memory proposals), 3d checks for regressions (revert proposals only), and 7d evaluates (change proposals). A proposal names a target (a group file or a memory entry), its rationale, and the metrics it expects to move. The human accepts or rejects each proposal in the Metrics tab, and that decision is a runtime record. An accepted proposal is explicitly linked (by the human or the reporting agent, never inferred) to the recorded version change of its target file that implements it (a revert links to the change that brought its earlier version back), so later reports can check whether it moved its target.
- **Autonomy phase (a) only.** The lead proposes and the human applies. Phase (b), where the lead edits prompts through a PR and writes memory directly, is out of scope. It unlocks once guard metrics have a baseline, and this change records the memory hashes it will need.

Not in scope: currency or budgets (tokens only, consistent with `plan-supervision`); a "defects after done" metric, since no link from a follow-up fix to its origin exists yet; an agent tool that applies proposals or records the human's decision; auto-revert.

The work lands in two stages within this change: (1) recording, metrics core, tab, and tool; (2) reports and proposals, which need about two weeks of stage-1 data before a 7d report has a baseline.

## Capabilities

### New Capabilities
- `chat-turn-usage`: per-turn token usage records for every completed chat turn, with group, profile, model, and task attribution.
- `agent-start-provenance`: a record per agent start of the group-file hash, memory hash, profile, and model it ran with.
- `team-process-metrics`: the windowed metric set with sample sizes, baselines, and guard pairs, surfaced in the Team page Metrics tab and the read-only `team_metrics` tool.
- `process-reports`: lead-written windowed reports with proposals, window roles, and the human-only accept/reject decision linked to the implementing prompt version.

### Modified Capabilities
- `team-tasks`: task status transitions are recorded as append-only rows (who, from, to, when).

`plan-supervision` is an unarchived change, not a spec. Its usage requirement and D14 should be amended to depend on `chat-turn-usage` rather than define their own table.

## Impact

- Server: `ChatSessionDriver` (usage on `turn_completed`), the agent start path and `groupCatalog.ts` (provenance), a new `src/server/metrics/` (core, store for reports and decisions, connection handlers), and the `kawai-team` MCP server (`team_metrics` plus report tools).
- SQLite: additive tables for turn usage, agent starts, reports, proposals, and decisions.
- Client: a Metrics tab in `TeamWorkspaceView`, a store, and `#/team/<key>/metrics` routing.
- WebSocket: new snapshot/push and decision messages, added to `CHAT_CONNECTION_TYPES`.
- Group config: the lead's prompt gains report scheduling and window rules (`.kawai/groups/lead.md`).
- Coordination: amend `plan-supervision` D14 and its usage requirement.
