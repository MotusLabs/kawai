## Purpose

Make tool-call failures of managed chat agents observable by tool and by cause, so a tool whose schema, wording, or availability misleads agents shows up in metrics instead of only in transcripts.

## ADDED Requirements

### Requirement: Tool calls are recorded with a bounded tool name
Every tool call of a managed chat, Claude or Codex, SHALL be recorded with a bounded tool name:
- a CLI built-in by its name;
- a `kawai-team` tool by its own name in both runtimes;
- any other MCP tool as `mcp:other`;
- anything else as `other`.

Tool inputs and outputs SHALL NOT be stored.

#### Scenario: Same team tool in both runtimes
- **WHEN** a Claude agent calls `mcp__kawai-team__task_submit_result` and a Codex agent calls `task_submit_result` in the `kawai-team` namespace
- **THEN** both calls are recorded with tool name `task_submit_result`

#### Scenario: Foreign MCP tool
- **WHEN** an agent calls a tool of an MCP server other than `kawai-team`
- **THEN** the call is recorded as `mcp:other`, and the server and tool names do not appear

### Requirement: Failed tool results carry a failure class
A failed tool result SHALL be recorded with exactly one failure class:
- `input-invalid` for a runtime schema refusal;
- `refused` for a `kawai-team` handler refusal;
- `precondition` for a CLI tool-use check;
- `blocked` for a harness block;
- `unavailable` for an unknown tool;
- `denied` for a denied approval;
- `command-failed` for a shell or Monitor failure;
- `other` otherwise.

The result text SHALL only be classified, never kept.

#### Scenario: Schema refusal
- **WHEN** a tool result reads `Input validation error: Invalid arguments for tool task_submit_result: …`
- **THEN** the call is recorded as failed with class `input-invalid`

#### Scenario: Handler refusal
- **WHEN** a `kawai-team` tool's handler refuses the call with its own message
- **THEN** the call is recorded as failed with class `refused`

#### Scenario: Unrecognized failure text
- **WHEN** a failed result's text matches no known class
- **THEN** the call is recorded with class `other`

### Requirement: Failure streaks are recorded
Consecutive failed results of one tool within one turn SHALL form a streak:
- a success of that tool closes it as `recovered`;
- the turn's end closes it as `abandoned`;
- a restart that loses it closes it as `unknown`.

Each closed streak SHALL be kept as a fact for 90 days with its tool, length, resolution, and first failed call. Calls to other tools SHALL NOT break a streak.

#### Scenario: Recovered after probing
- **WHEN** `task_submit_result` fails four times in a turn, with `task_get` calls between, and then succeeds
- **THEN** one `recovered` streak of length 4 is recorded

#### Scenario: Gave up
- **WHEN** `task_submit_result` fails six times and the turn ends without a success
- **THEN** one `abandoned` streak of length 6 is recorded

#### Scenario: Restart mid-streak
- **WHEN** the server restarts while a streak is open
- **THEN** the streak is closed as `unknown` with the failures observed before the restart

### Requirement: Tool call metrics are exported
When metrics export is enabled, Kawai SHALL export:
- a tool-call counter by team, group, provider, model, tool, outcome, and failure class;
- a streak counter by the same identity, tool, and resolution;
- a histogram of streak lengths.

All of them SHALL be subject to the existing label bounds. Exported totals SHALL survive detail pruning.

#### Scenario: Many distinct foreign tools
- **WHEN** agents call 500 differently named tools of foreign MCP servers
- **THEN** they are exported under the single tool label `mcp:other`

#### Scenario: Scrape after pruning
- **WHEN** tool observations older than the detail horizon are pruned
- **THEN** the exported tool-call and streak totals are unchanged
