# Design

## Context

See proposal.md (Why). Existing pieces this change builds on:

- `src/server/team/convergenceNotice.ts` (review-convergence decision 10):
  the manual-task notice pattern. One `store.immediate` transaction inserts a
  keyed row (`INSERT OR IGNORE`), journals as `SYSTEM_ACTOR`, and enqueues one
  system message to an agent creator.
- `MailboxStore.subscribe` (`src/server/team/mailboxStore.ts`): listeners run
  after every state change, `enqueue` included, with the message. The plan
  supervision monitor (`monitorComposition.ts`) and `executionRuntime.ts`
  already subscribe this way.
- `SessionMailbox` (`src/server/team/sessionMailbox.ts`) builds the
  `MailboxStore` and the `TaskResultService`, whose `ownedByExecution(taskId)`
  is the ownership test the findings ledger already uses.
- Progress sources: `team_task_revisions.created_at`,
  `team_task_results.created_at`, and counted reviews
  (`findings.countedSubmissions(taskId)[].createdAt`).

## Goals / Non-Goals

**Goals:**
- One pure derivation of a task's stall state, used by the evaluation and
  by tests (oracle hazard "Several readers disagreeing on derived state").
- Event-driven, with no timer and no startup sweep.
- Restart-safe through a durable replay key.

**Non-Goals:**
- Counting journal notes. Advisory content also lands in notes, but notes
  are written by the writer as well as advisors, and mail already marks each
  exchange.
- Team-page attention items, per-team thresholds, or notices to the writer.
- Any change to the convergence notice or to plan stall alerts.

## Decisions

### D1. Anchor and count come from one pure function

`stallOf(input) → { anchorAt, anchorKind, count, senders, elapsedMs, due }`
in `src/shared/taskStall.ts`. Input: task status, owned flag, created time,
newest revision time, newest result time, newest counted review time, newest
notice time, the task's mail (created time, from kind, from session, from
group), and `now`. Anchor kind is one of `created`, `revision`, `result`,
`review`, `notice`. Ties go to the earlier kind in that list (only the label
depends on it). Counted mail is `fromKind ∈ {agent, human}` and
`createdAt > anchorAt`. `due` holds exactly when D2's table says notice.

*Alternative:* separate SQL counts in the notice module. Rejected, because
the decision would then be split across code and the oracle table could not
reach it.

### D2. Evaluated on each committed task mail, in its own transaction

A `TaskStallNotices` module subscribes to `MailboxStore`. Mail is often
enqueued inside a caller's transaction (assignments, revision notices,
decision answers), and the existing listeners (`executionRuntime.ts`,
`monitorComposition.ts`) only schedule work. So the listener only adds the
message's `taskId` to a pending set, for a message with a `taskId` and
`fromKind ≠ system`. One coalesced `setImmediate` flush, which runs after
the caller has committed, evaluates each pending task in its own
`store.immediate` transaction. That transaction reads D1's inputs, calls
`stallOf`, and, when due, does `INSERT OR IGNORE INTO
team_task_stall_notices (task_id, anchor_at, …)`. Only when the insert
changed a row does it also journal and enqueue the creator message. A rolled-back caller
leaves no message, so the flush finds nothing new to count. Errors are
caught per task and logged, never rethrown from the callback. A missed
evaluation (a crash before the flush) is recovered by the next counted mail
on the task. That is the only case that matters: without new mail, nothing
new can become due.

*Alternative:* evaluate inside the mail's own transaction. Rejected: it
couples every send path (`prepareSend`, `prepareReply`, decision answers,
assignments) to task-store reads, and plan supervision already proves the
listener pattern.

*Alternative:* a 60 s sweep, like plan supervision. Rejected: the thresholds
need a new message anyway, so a timer adds load and recovery code for nothing.

### D3. Schema

Migration `task-stall-notices` (next version after `review-convergence`),
additive, no backfill:

```
CREATE TABLE IF NOT EXISTS team_task_stall_notices (
  task_id TEXT NOT NULL, anchor_at TEXT NOT NULL, anchor_kind TEXT NOT NULL,
  message_count INTEGER NOT NULL, message_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, anchor_at));
```

The newest row's `created_at` is the `notice` anchor. `message_id` is null
for a human creator, or when no mailbox is attached.

### D4. Notice content

Journal (system): `Stall notice: <count> messages from <senders> in <h m>
since <anchorKind> at <anchorAt>, with no new revision, result, or counted
review. Judge it by "Keep advisory checkpoints separate from final review"
(docs/agent-collaboration.md); nothing waits.` The message to the creator
session (`fromKind: system`, `taskId`, tags `[task-stall]`) carries the same
facts and the options: submit for formal review, record a reason for another
advisory round, narrow the task, or escalate. Constants
`STALL_MESSAGE_THRESHOLD = 10` and `STALL_ELAPSED_MS = 3 h` are exported
from `taskStall.ts`.

## Acceptance oracles

### Decision table SN (`stallOf(...).due`)

| id | status | owned | count ≥ 10 | elapsed ≥ 3 h | due |
|---|---|---|---|---|---|
| SN1 | open/active | no | yes | yes | **yes** |
| SN2 | open/active | no | yes | no | no |
| SN3 | open/active | no | no | yes | no |
| SN4 | open/active | no | no | no | no |
| SN5 | * | yes | * | * | no |
| SN6 | blocked/done/cancelled | * | * | * | no |

Boundaries: count exactly 10 and elapsed exactly 3 h are `yes` (SN1).
Count 9 or elapsed 3 h − 1 ms are `no`.

### Decision table AN (anchor and count)

| id | newest event after creation | mail after anchor | anchor kind | count |
|---|---|---|---|---|
| AN1 | none | 3 agent, 1 human | created | 4 |
| AN2 | revision | 2 before it, 1 after | revision | 1 |
| AN3 | result | 5 after | result | 5 |
| AN4 | counted review (uncounted review only → no change) | 2 after | review / created | 2 / all |
| AN5 | notice | 4 after | notice | 4 |
| AN6 | none | 12 system | created | 0 |

Unreachable: an anchor later than `now` (all times come from the same clock;
a skewed row is treated as elapsed 0, so not due).

### Decision table EF (effects of one evaluation)

| id | due | row for (task, anchor) exists | creator | row | journal | message |
|---|---|---|---|---|---|---|
| EF1 | yes | no | agent session | +1 | +1 | +1 tagged `task-stall` |
| EF2 | yes | no | human | +1 | +1 | 0 |
| EF3 | yes | yes | * | 0 | 0 | 0 |
| EF4 | no | * | * | 0 | 0 | 0 |

### Properties

- **P1 at most one per episode:** for seeded sequences (seed `0x57A11`,
  300 cases) of mail (some enqueued inside an outer transaction that then
  rolls back), revisions, results, counted reviews, clock advances,
  duplicate listener calls, and a simulated crash before the flush
  (skipped evaluation), every `(task, anchor)` has ≤ 1 row, ≤ 1 journal
  entry, and ≤ 1 message. Notices equal the reference model, which replays
  `stallOf` over the same sequence and skips evaluations dropped by the crash.
- **P2 nothing else changes:** across the same sequences, the task status,
  assignment rows, finding rows, and every non-notice message are identical
  to a run with the module unsubscribed.

### Hazards consulted (docs/oracle-hazards.md)

- *An idempotence oracle observing only the uniquely constrained row:* EF3
  and P1 snapshot the notice rows, journal, and mail before and after a
  replay. The control bypasses the `changes === 0` guard.
- *M1 an oracle behind a hand-built harness:* one SN1 row runs through
  `SessionMailbox`'s production composition. Its mutant removes the
  subscription.
- *Several readers disagreeing on derived state:* D1's single function is
  shared by the module and the tables.

## Risks / Trade-offs

- [A long, legitimate task with heavy coordination gets noticed every
  3 h / 10 messages] → The notice is advisory and journaled. Thresholds are
  constants and can be tuned in one place.
- [Advisory content sent as notes rather than mail is invisible] → Accepted
  (Non-Goals). The pckh coordinator works by mail.
- [Listener throws on a corrupt row] → Caught and logged. Mail delivery
  never depends on it.

## Migration Plan

Additive migration with no backfill. Rollback is dropping the module; the
table is inert. Tasks that are already long-running get their first notice
at their next counted mail once the thresholds hold from their current anchor.

## Implementation contract

### Acceptance
- A1: SN1–SN6, AN1–AN6, and EF1–EF4 each pass as a named table test against the shipped `stallOf` and notice module.
- A2: A counted message on an active manual task past both thresholds, sent through the production `SessionMailbox`, produces exactly one `team_task_stall_notices` row, one system journal entry, and, for an agent creator, one message tagged `task-stall` on the task.
- A3: P1 and P2 hold over 300 seeded cases with seed `0x57A11`.
- A4: `docs/architecture/tasks.md`, `docs/agent-collaboration.md`, and `docs/recovery-matrix.md` describe the notice, and the recovery-matrix test passes.

### Invariants
- I1: A stall notice never changes a task's status, assignment, revision, result, or finding.
- I2: At most one notice exists per `(task_id, anchor_at)`.
- I3: Kawai's own mail is never counted and never triggers an evaluation.
- I4: A task an execution owns never gets a stall notice.

### Scope
- src/shared/taskStall.ts
- src/server/team/taskStallNotices.ts
- src/server/team/sessionMailbox.ts
- src/server/team/taskStallSchema.ts
- src/server/dbSafety/migrations.ts
- src/server/__tests__/taskStall*.test.ts
- src/shared/__tests__/taskStall*.test.ts
- src/server/__tests__/schemaMigrations.test.ts
- src/server/__tests__/schemaBaselinePin.test.ts
- docs/architecture/tasks.md
- docs/agent-collaboration.md
- docs/recovery-matrix.md
- openspec/changes/manual-task-stall-alerts/**

### Verification
- V1: `bun run test src/shared/__tests__/taskStall.test.ts src/server/__tests__/taskStallNotices.test.ts` passes, with every SN, AN, and EF row a named test.
- V2: Mutants are killed: SN boundary `>=` → `>`; counting system mail; anchor ignoring counted reviews; the `changes === 0` guard bypassed; the subscription removed from `SessionMailbox`.
- V3: `bun run check` passes on the clean committed tree.
- V4: Every scenario in `specs/task-stall-notices/spec.md` carries an `@covers` annotation.

### Excluded
- X1: No client or Team-page change.
- X2: No change to `convergenceNotice.ts`, plan supervision, or mail routing and delivery.
- X3: No configurable thresholds.
