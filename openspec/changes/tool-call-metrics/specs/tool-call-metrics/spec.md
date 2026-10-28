## Purpose

Make tool-call failures of managed chat agents observable by tool and by cause, so a tool whose schema, wording, or availability misleads agents shows up in metrics instead of only in transcripts — with bounded, honest accounting that never claims more than the recorded history proves.

## ADDED Requirements

### Requirement: Tool calls are admitted and identified within bounds
Every admitted tool call SHALL carry a bounded identity: a CLI built-in or exact `kawai-team` member by name in both runtimes; ambiguous shapes (`mcp__dynamic__…`, extra separators, collapsed agent tools, empty, bare `echo`) `unknown`; any other distinct raw name one of at most 96 opaque live slots, the 97th `unknown`. Only slotted identities are reliable. Admission follows the live-driver contract and fences; replay never enters. Raw names, inputs, and outputs SHALL NOT be stored.

#### Scenario: Same team tool in both runtimes
- **WHEN** a Claude agent calls `mcp__kawai-team__task_submit_result` and a Codex agent calls `task_submit_result` in the `kawai-team` namespace
- **THEN** both calls are recorded with the identity and name `task_submit_result`

#### Scenario: Foreign MCP tool
- **WHEN** an agent calls a tool of an MCP server other than `kawai-team`
- **THEN** the call is recorded under an opaque slot whose export label is `mcp:other`, and the server and tool names do not appear

#### Scenario: Colliding namespace stays unknown
- **WHEN** the Codex adapter reports `mcp__dynamic__echo` for a namespace-less dynamic call, and another call comes from a real MCP server named `dynamic` exposing `echo`
- **THEN** both are recorded with `unknown` identity, both count in totals, and neither enters any failure streak

#### Scenario: Bare echo stays unknown
- **WHEN** two failed results arrive for a tool named exactly `echo`
- **THEN** both count with label `other` and `unknown` identity, and no streak opens

#### Scenario: Saturation stops measurement honestly
- **WHEN** a 513th distinct call id appears in one turn
- **THEN** open streaks close `unknown` once, no further streak opens that turn, already-admitted calls still settle exactly once, and the saturation is disclosed rather than silently evicting state

#### Scenario: Replayed history stays outside
- **WHEN** a `turn_started` for a turn with a retained 90-day closure is replayed
- **THEN** the fence rejects it and no observation, fact, or total changes

### Requirement: Tool results are classified once
A success SHALL count as a call with class `none` whatever its text or linked denial. A failure SHALL get one class by an ordered, anchored pass: trusted linked denial; wrapper and tool prefixes (`input-invalid`, `unavailable`, `blocked`, `precondition`); `Refused: ` from an exact team tool; Bash-only and Edit-only decline phrases; `command-failed` for Bash and Monitor; else `other`. The label never overrides identity membership. Result text SHALL only be classified, never kept.

#### Scenario: Schema refusal
- **WHEN** a tool result reads `Input validation error: Invalid arguments for tool task_submit_result: …`
- **THEN** the call is recorded as failed with class `input-invalid`

#### Scenario: Handler refusal
- **WHEN** a `kawai-team` tool's handler refuses the call with its own `Refused: …` message
- **THEN** the call is recorded as failed with class `refused`

#### Scenario: Trusted denial precedes text
- **WHEN** the call's linked approval resolved `denied` and the failed result text matches no known phrase
- **THEN** the call is recorded `denied` from the trusted link, not from output text

#### Scenario: Success is never reclassified
- **WHEN** a result is a success but its text contains failure-like wording and its approval was denied
- **THEN** it is recorded and exported as a success with `failure_class` `none`, stores no failure class, and counts in the denominator

#### Scenario: Successes count in the failure ratio
- **WHEN** one tool has nine successful results and one failed result
- **THEN** the tool-call counter totals 10 and the failure rate reads 10%

#### Scenario: Decline phrases are tool-specific
- **WHEN** a failed Monitor reads `The command was declined.` and a failed Write reads `The file change declined.`, with no linked denial
- **THEN** they are classed `command-failed` and `other`, while the same phrases from Bash and Edit are `denied`

#### Scenario: Generic team failure is not a refusal
- **WHEN** a `kawai-team` tool fails with `Unknown team: t1`
- **THEN** the call is recorded with class `other`

#### Scenario: Unrecognized failure text
- **WHEN** a failed result's text matches no known pattern
- **THEN** the call is recorded with class `other`

### Requirement: Failure streaks close conservatively
Consecutive failed results of one tool within one turn SHALL form a streak; a success of that tool closes it `recovered`, the turn end `abandoned`, a restart `unknown` (a lower bound). A quarantined orphan result or an advanced recorder-failure counter SHALL close open streaks `unknown` once and taint the turn, forbidding exact closure claims across the gap. Other tools do not break a streak. Each closed streak SHALL be a 90-day fact with tool, length, resolution, and opening failed call.

#### Scenario: Recovered after probing
- **WHEN** `task_submit_result` fails four times in a turn, with `task_get` calls between, and then succeeds
- **THEN** one `recovered` streak of length 4 is recorded with its opening failed call

#### Scenario: Gave up
- **WHEN** `task_submit_result` fails six times and the turn ends without a success
- **THEN** one `abandoned` streak of length 6 is recorded

#### Scenario: Restart mid-streak
- **WHEN** the server restarts while a streak is open
- **THEN** the streak is closed `unknown` with the failures observed before the restart, as a lower bound

#### Scenario: Recording gap taints the turn
- **WHEN** a result's write rolls back and a later success commits, with unrelated health work succeeding in between
- **THEN** the open streak closes `unknown` once before the later success, no `recovered` fact is written, and repeated checkpoints or turn ends cannot duplicate the closure

#### Scenario: Orphan result taints first history
- **WHEN** a result arrives whose call was never admitted and cannot be
- **THEN** open streaks close `unknown` once, the turn is tainted for first-attempt purposes, and the orphan never becomes eligible

### Requirement: First attempts are measured only for closed, untainted turns
The first ACTUAL call per turn and exact team tool owns the first-attempt marker. A result is eligible only when its completion lies in the window and a valid same-snapshot `turn_ended` fact shows coverage version 1 without taint; unclosed, tainted, legacy, or missing-carrier turns are excluded (partial or unrecorded), never successes or zeros. Turn close SHALL persist coverage version and taint scalars on the 90-day `turn_ended` fact; a missing or invalid carrier is `unrecorded`.

#### Scenario: First actual call wins regardless of result order
- **WHEN** call c1 is made first, c2 second, and results arrive as c2-failed then c1-successful
- **THEN** the first-attempt marker stays on c1 and the recovered streak's opening failure is c2

#### Scenario: Orphan taint excludes an earlier first
- **WHEN** c1 succeeded with its first-attempt marker, then a quarantined orphan result arrived, then the turn closed
- **THEN** the first-attempt cohort for that turn is empty (n=0, partial), and no other result is promoted to first

#### Scenario: Known first outside the window
- **WHEN** a turn's first completion happened before the requested window
- **THEN** the metric reads n=0 for that turn in the window, not missing history and not a success

### Requirement: Tool call metrics are exported behind an activation gate
Kawai SHALL export the tool-call counter (tool, outcome, failure_class), streak counter (+ resolution), and streak-length histogram within the existing bounds (tool enum ≤96) and 250,000/10,000 budgets. One transaction SHALL check existing series plus all missing catch-alls and diagnostics, then reserve all with the `tool-export-v2` active marker or nothing. Later admission SHALL use actual remaining capacity, no fixed reserve. Totals survive detail pruning.

#### Scenario: Many distinct foreign tools
- **WHEN** agents in one turn call 500 differently named tools of foreign MCP servers
- **THEN** all count under the single tool label `mcp:other`, at most 96 keep distinct opaque identities, the rest are `unknown` with identity incomplete, and no raw name is stored

#### Scenario: Budget refusal stops all three families together
- **WHEN** existing series 249,960 plus the missing catch-alls (11) and diagnostics (35) would exceed the series budget
- **THEN** the checkpoint reads `budget-unavailable` with a reason and null `availableSince`, no reservation row is written, no new label of the three families is admitted while already-admitted totals keep incrementing, and every other family keeps its old values and behaviour

#### Scenario: Paid reservations are not reserved again
- **WHEN** activation succeeded at 249,986 series with every diagnostic admitted and a new histogram labelset costing 9 arrives
- **THEN** it is admitted at 249,995, and a second activation inserts nothing and keeps `availableSince`

#### Scenario: Scrape after pruning
- **WHEN** tool observations older than the detail horizon are pruned
- **THEN** the exported tool-call and streak totals are unchanged

#### Scenario: Reactivation starts a new boundary
- **WHEN** export was budget-unavailable and a later activation succeeds
- **THEN** the checkpoint records a new `availableSince` at that success, and the skipped interval is never backfilled, reset, or replayed

#### Scenario: Suppressed families render nothing
- **WHEN** the families are not active
- **THEN** no sample, zero-filled family, or diagnostic family appears for them, and stored pre-refusal values stay suppressed rather than rendered as unadmitted

### Requirement: Unresolved recovery fails closed
On process start, each existing live-checkpoint row SHALL recover in its own transaction after its core identity and state are validated; a valid row recovers exactly once (as `unrecorded` when it holds no tool state), and a malformed, scope-mismatched, or state-unusable row SHALL stay byte-unchanged and block that session's further metric admission, counted only by the fixed `tool-recovery-quarantine` checkpoint — never deleted, rewritten, or auto-reset.

#### Scenario: Valid row recovers once
- **WHEN** a valid live row with an open streak is recovered twice
- **THEN** exactly one unknown closure is recorded and the second recovery is a no-op

#### Scenario: Malformed row quarantined and blocked
- **WHEN** one session's live row is malformed and another session's valid row recovers
- **THEN** the valid row recovers, the malformed row stays byte-unchanged, its session records no further tracker metrics, and the quarantine checkpoint counts it without any raw content

#### Scenario: Quarantine persists across restart
- **WHEN** the process restarts with a quarantined row still present
- **THEN** the row is still quarantined and blocked, and resolution still requires an authorized recovery policy

#### Scenario: Count write failure leaves health unknown
- **WHEN** the quarantine checkpoint write fails
- **THEN** recovery health reads unknown (not zero and not the previously stored count), and the admission gate still holds for the quarantined session
