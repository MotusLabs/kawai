# Design

## Context

See proposal.md, "Why". The parts this design builds on, as shipped:

- **The ledger** (`src/shared/findingsLedger.ts`). `foldLedger` folds a
  task's counted submissions and events, ordered by `ledgerSeq`, into one row
  per finding. Each row has a state, a level, a clause id, a locus, and its
  transitions.
  - Blocking means P0/P1 in `accepted`, `still-open`, or `reopened`.
  - A re-raise of a resolved finding on the same clause key and locus reuses
    its id and enters `reopened` (table RO).
  - Each counted submission records the contract identity it was judged
    under (`r<N>#<hash12>`).
  - No finding field links two findings to each other, so S2 is computed
    from clauses alone (decision 2).
- **The fix step** (`executor.ts` `applyFix`). On a failed round it calls
  `fixRoundOutcome(count, round)`. That function stops the change as
  `round-limit` at `ROUND_LIMIT = 3`, or else ensures and dispatches a keyed
  fix attempt and moves the change to `implementing`. The planner emits the
  fix step for a `gating` or `landing` change whose round failed.
- **The structured review decision** (`decideVerdict`). It records the
  failed round's `blockingIds`; text reviews leave that field null.
  `regateRefuted` (table RG) passes a failed round's result again when every
  blocker was rejected and a fix attempt is still out.
- **Supervision** (`planSupervision.ts`). It derives `repeating-failure` from
  `failureSignature`, which appends `review:fail` for any failed review, so
  any two failed reviews stall. Stall alerts are keyed by episode in
  `plan_stall_alerts`.
- **Cards** (`DecisionService`). Every card has an asking session. The
  dispute cards of `askForTask` are asked on the disputing session's
  behalf. Free-text choices are allowed. A decision on a card that has a
  `messageId` replies to that message.
- **Contract changes.** Only the human publishes a new revision of an
  execution task ("Artifact edits never change an execution task's
  contract"). The planner's `revision` stage fires only for an open or
  passed round; a failed round's fix is expected to carry the new revision.

## Goals / Non-Goals

**Goals:**

- One pure signal function, shared by the executor, the manual-task notice,
  supervision, and the Plans view (the "several readers" hazard).
- A diagnosis that survives restart from stored rows alone, with no
  in-memory listener on the decision path.
- Every outcome reuses an existing, already-keyed path: the fix dispatch,
  the re-gate insert, a stop, the revision path.

**Non-Goals:**

- Changing the gate, the ledger fold, dispositions, or disputes.
- Letting any agent publish a task revision.
- Editing `team-workspace-redesign` (proposal, "Overlap").
- Showing signals in the Task view's findings section.

## Decisions

### 1. One pure module computes reviews, the window, and the signals

`src/shared/reviewConvergence.ts` exports the following:

- `reviewSnapshots(submissions, events)` gives one snapshot per counted
  submission, in `ledgerSeq` order, with these fields:
  - `submissionId`, `ledgerSeq`, and `contractHash` (the part of the
    identity after `#`; `''` when the identity is null);
  - `raised`: finding items of class `accepted` at P0/P1, which covers new
    findings and re-raises;
  - `resolved`: disposition items `resolved`;
  - `outOfContract`: finding items of class `out-of-contract`;
  - `reopened`: raised items whose row entered `reopened`;
  - `openAfter`: `blocking(...).length` of the fold over every submission
    and event with `ledgerSeq` up to and including this submission's.

  Events after a review count toward the next review.
- `convergenceWindow(snapshots, anchorSubmissionId)` gives the trailing run
  of snapshots whose `contractHash` equals the newest's, strictly after the
  anchor and strictly after the newest earlier snapshot with `openAfter`
  0 (a passing review restarts the window, as a pass resets the fix
  count). The anchor is the review of the newest closed diagnosis (or, for a
  manual task, of the newest notice).
- `convergenceSignals(window, rows)` gives `Signal[]`, in the order S1 to S5.
  Each signal carries its evidence: finding ids, the clause for S2, and the
  counts for S4.

S1 counts a row's `reopened` transitions up to the newest review: at least
two, with one of them made by the newest review. S3 needs the newest review
itself to raise a blocking finding: a review that only keeps findings open
is a flat count, which S4 judges over three reviews. S2 keys on `clauseId`
only, so revision citations (a null `clauseId`) never count.

Alternative: compute the signals in SQL over the submission tables. That
was rejected because the fold already exists in shared code, and a second
derivation is the drift the hazard catalog names ("Several readers
disagreeing on derived state").

### 2. S2 without a new field

S2 fires when each of the last two window reviews has a clause C with one
item resolving a finding on C and another item raising a blocking finding
on C. Two findings on one clause, where fixing one surfaces the other, is
the observable form of "the clause is underspecified". A reviewer-set
`conflicts_with` link was rejected (owner decision): it changes two
submission schemas, and it relies on reviewers to notice the conflict.

### 3. The backstop is recorded at Start

`teamCaps.ts` parses `planExecution.maxFailedFixRounds`: an integer from 2
to 20, default 5. A malformed value is logged and the default is used.
Start records it on the execution row (`max_failed_fix_rounds`, default 5
for existing rows), as the parallel limit is recorded, so a running
execution keeps its value. `fixRoundOutcome(count, round, limit)` returns
`{ count, backstop }`. `ROUND_LIMIT` and the `round-limit` write are
removed. The stop reason, its label, and Retry's handling of it stay for
rows stopped before the upgrade. The fix instruction reads "fix round N of
<limit>".

### 4. The diagnosis is a step of `gating`, recorded in its own table

A new change step `diagnosing` under state `gating` holds the change, and a
new table records each diagnosis:

```
plan_execution_diagnoses(
  id TEXT PRIMARY KEY, execution_id, change, round_id TEXT NOT NULL UNIQUE,
  review_submission_id TEXT,          -- the counted review it opened on; null for a backstop on a review-less round
  signals_json TEXT NOT NULL,         -- [{ kind: 'S1'..'S5' | 'backstop', evidence }]
  card_id TEXT NOT NULL, message_id TEXT,
  opened_at, outcome TEXT,            -- null | 'amend' while open; the applied outcome when closed
  decision_id TEXT, closed_at TEXT, close_reason TEXT)  -- 'decision' | 'revision'
```

`UNIQUE(round_id)` is the replay key: a failed round opens at most one
diagnosis. A new state was rejected, because every reader of
`ChangeState` (labels, the planner, `agentHeldStage`, the view) would need
a new case. A step under `gating` already means "Kawai holds it, nobody is
dispatched".

**The open step.** `applyFix` evaluates, in order:

1. Signals. They are evaluated only when the round's `blockingIds` is
   non-null and its counted review is the window's newest.
2. The backstop.

If either fires, one transaction:

- inserts the diagnosis row;
- raises the card (decision 6), with its mail and the `plan_stall_alerts`
  row for the episode (key = diagnosis id, message = the card's mail);
- transitions the change to `gating`/`diagnosing`, leaving the landing slot
  as the fix transition does for a carried round;
- journals the signals.

A crash before the commit leaves nothing, and the next tick re-runs the
step. A crash after it leaves the row, and the planner sees `diagnosing`.

### 5. The tick applies the decision from rows

For a `gating`/`diagnosing` change, the planner emits a `diagnosis` stage
instead of `fixes`. The stage reads the open diagnosis and acts on the
first matching case:

1. **A newer task revision.** If the task's revision is past the failed
   round's result revision, the stage closes the diagnosis (`revision`) and
   dispatches the fix naming the revision, with the count at 0. This is the
   case the planner's `revision` stage leaves to "the failed round's fix",
   and here no fix is out yet.
2. **Waiting.** If the card has no decision, or its newest decision is the
   one already applied as `amend`, nothing happens.
3. **Otherwise,** it applies the newest decision's outcome (decision 7).

Applying is idempotent, with no listener and no replay key beyond the rows
already in use:

- the fix dispatch is keyed by its attempt (`ensureFixAttempt` and
  `dispatchFix`, as in `applyFix`);
- the closing write is guarded by the change's generation and by
  `closed_at IS NULL`;
- rejections skip findings that already read rejected.

A crash after the dispatch but before the close re-runs the stage, which
replays the same key. Under a hold, the dispatch is owed exactly as
`applyFix`'s is (the attempt row stands, and the release dispatches it).

### 6. Kawai asks the card

`raiseDiagnosisCard` (`src/server/plans/decisions/diagnosisCards.ts`)
builds the card inside the executor's open transaction, through
`DecisionStore` and the mail store. `DecisionService` is not used: it is
composed after the executor and its writes are async. Its fields:

- `kind: 'diagnosis'` (new column on cards, default `'question'`);
- `askedBy: { session: 'kawai', group: null, profile: null }`;
- the task scope of the change;
- addressed to the plan's Lead role, else the owner. Kawai is never in the
  Lead group, so `askForTask`'s exemption for an asker inside the Lead
  group does not apply.

The mail is a system enqueue, as stall alerts are: to the Lead group,
with that role's profiles, tagged `decision-question`, `plan-stall`, and
`stall:convergence`. Its id is the card's `messageId`, so the existing
reply guard refuses replies while the card is open.

For `kind = 'diagnosis'`, two rules change:

- `resolveChoice` refuses free text that is not exactly one of the
  options, for the Lead's record and for the owner's answer and override
  alike;
- `record` sends no answer mail, because the outcome is the reply.

Options are built in the order of the spec "A diagnosis card offers the
outcomes that apply". The `Reject` option lists the blocking findings
named in the signals' evidence, sorted by number, at most ten. When the
signals name no finding at all (S4, the backstop), it lists every blocking
finding instead. So S5 alone, whose findings never block, offers no
`Reject`.

### 7. Outcomes

| Outcome | Writes (one transaction unless noted) | Closes |
|---|---|---|
| `Fix round` | Fix input as in `applyFix`, plus `diagnosis: { rationale }` in the handoff. Ensure and dispatch, then transition to `implementing` with `fixRounds: 0`. | yes |
| `Reject F…` | `rejected` ledger events, carrying the card and decision ids, for each named finding still blocking. Then: if `roundReview(fold) = 'pass'`, a re-gate round for the failed round's result (`insertRegateRound(failed, failed.attemptId)`: `attempt_id` is NOT NULL, and no fix attempt was sent, so the round answers the failed round's own attempt) and a transition to `gating` passed with `fixRounds: 0`; else the fix dispatch, as for `Fix round`, listing what still blocks or awaits a dispute. | yes |
| `Amend the contract` | `outcome = 'amend'`, `decision_id`, and a journal entry. | no; case 1 of decision 5 closes it |
| `Reassign to <g>` | `group_override = g` on the change row; the fix dispatch to `g`; a tick step releases the previous implementer once ready (as `releaseFinishedReviewers` does). | yes |
| `Escalate` | Stop as `diagnosis-escalated`, with the detail `{ signals, rationale }`. | yes |

Every fix and update dispatch reads `row.groupOverride ?? revision group`,
and so does Retry.

A rejection by a diagnosis is an event with a `cardId` that is not the
dispute card's. A later decision on a dispute card of that finding is
therefore `ignored` by `decisionApplies`, unchanged.

The decision applied is always the card's newest one. An override while
the diagnosis is open (only `amend` stays open) applies its new choice. An
override after the close is only journaled, and it creates its forward-fix
task as for any card.

### 8. Supervision

- `SupervisionRound` gains `structuredReview: boolean`, and
  `failureSignature` adds `review:fail` only when it is false.
- `SupervisionInput` gains `diagnosis` (the open one, or null).
- The new stall is
  `{ kind: 'convergence', episodeKey: diagnosisId, signals, cardId, awaitingRevision }`.
  It takes precedence over `repeating-failure`.
- Waits: the card's `decision-card` wait while it is undecided, and a new
  `contract-revision` wait (the task and its next revision number) after
  `amend`.
- The stall-alert sweep finds the convergence episode's row, already
  written at open, and sends nothing.
- `planAttention.ts` emits the following:
  - nothing for a convergence stall while its card is open (the card's item
    stands for it);
  - after `amend`, one human item, **Publish a task revision**, with the
    rationale and a link to the task.
- Labels:
  - cause: `Stalled: convergence (S3, S4)`;
  - stop reason: `diagnosis-escalated` reads "Escalated after a diagnosis".

### 9. Plans view

`ExecutionChangeView` gains
`convergence: { counts: number[]; signals: string[] | null } | null`.
`executionView.ts` fills it from `reviewSnapshots` and `convergenceWindow`
over the change's task. `PlanExecutionChangeRow.tsx` renders "Open P0/P1 by
review: 5 → 3 → 1", plus the open diagnosis's signals with a link to its
card.

### 10. Manual tasks

After a counted review submission commits on a task that
`ownership.ownerOfTask` does not own, `TaskFindingService` computes the
signals. The window is anchored at the newest row of
`team_task_convergence_notices(submission_id PRIMARY KEY, task_id, signals_json, created_at)`.
If any signal fires, one transaction does the following:

- inserts the notice;
- journals the signals;
- enqueues one system message to the creator, when the creator is a
  session.

The primary key keeps a replayed submission from noticing twice.

### 11. Prompts and docs

- `lead.md`: the two-correction-rounds bullet is replaced by the diagnosis
  playbook. `change-leads.md` gets the same playbook, and `reviewers.md`'s
  "retain the two-unsuccessful-correction-round escalation" sentence is
  replaced by a pointer to the signals.
- `docs/agent-collaboration.md`, "Review protocol", gains a "Convergence"
  paragraph. It is the playbook's one home, and the prompts point at it.
- `docs/architecture/plan-execution.md` and `plan-supervision.md`: their
  bullets name the diagnosis.
- `docs/recovery-matrix.md` gets three rows (see V6).

### Acceptance oracles

**Table SG — signals over a window** (`convergenceSignals`; the reviews are
the window's, newest last; `*` means any value).

| id | reviews in window | condition on the window | fires |
|---|---|---|---|
| SG1 | ≥1 | newest raises a finding with ≥2 `reopened` transitions | S1 |
| SG2 | ≥1 | newest raises a finding's first reopen | — |
| SG3 | ≥2 | both of the last two: clause C resolved one finding and raised another blocking one | S2 |
| SG4 | ≥2 | as SG3 but on different clauses | — |
| SG5 | ≥2 | as SG3 but the findings cite the revision (`clauseId` null) | — |
| SG6 | ≥2 | the newest raised ≥ 1, and raised over the last two ≥ resolved | S3 |
| SG7 | ≥2 | raised < resolved | — |
| SG8 | ≥2 | raised = resolved = 0 | — |
| SG8a | ≥2 | the previous raised ≥ 1, the newest raised none (findings left `still-open`) | — |
| SG9 | ≥3 | openAfter non-decreasing over the last three, newest > 0 | S4 |
| SG10 | ≥3 | openAfter falls at least once among the last three | — |
| SG11 | ≥3 | non-decreasing and newest = 0 | — (unreachable when the round failed; kept for the manual notice) |
| SG12 | ≥2 | each of the last two raised an out-of-contract finding | S5 |
| SG13 | ≥2 | only the newest raised one | — |
| SG14 | 1 | any | only S1 can fire |
| SG15 | 0 | any | none |

**Table WN — the window** (`convergenceWindow`).

| id | contract hashes, oldest → newest | anchor | window |
|---|---|---|---|
| WN1 | H1 H1 H1 | none | all three |
| WN2 | H1 H1 H2 | none | the H2 review |
| WN3 | H1 H2 H1 | none | the last H1 review only (a run, not a set) |
| WN4 | H1 H1 H1 | the second | the third |
| WN5 | H1 H1 H1 | the third | empty |
| WN6 | r3#A, then r4#A (renumbered, same hash) | none | both |
| WN7 | H1 H1 H1, the second leaving `openAfter` 0 | none | the third |

**Table DO — opening a diagnosis at the fix step** (`applyFix`, per failed
round).

| id | structured review, newest in window | a signal fires | count after this round ≥ limit | diagnosis row for the round | result |
|---|---|---|---|---|---|
| DO1 | yes | yes | * | none | open, signals named |
| DO2 | yes | no | yes | none | open, `backstop` |
| DO3 | yes | no | no | none | fix dispatched |
| DO4 | no (CI-only, or text review) | — | yes | none | open, `backstop` |
| DO5 | no | — | no | none | fix dispatched |
| DO6 | * | * | * | exists | no second row or card; the planner is already on `diagnosis` |
| DO7 | yes, but not the newest (the review was already a closed diagnosis's anchor) | — | no | none | fix dispatched (the window is empty) |

**Table DX — the diagnosis stage** (one tick; "open" means `closed_at` is
null).

| id | task revision past the result's | newest decision | already applied | result |
|---|---|---|---|---|
| DX1 | yes | * | * | close `revision`; fix naming the revision, count 0 |
| DX2 | no | none | — | wait (nothing written) |
| DX3 | no | `Fix round` | no | fix with the rationale; `implementing`; count 0; close |
| DX4 | no | `Reject …`, nothing left blocking or disputed | no | rejected events; re-gate round passes; count 0; close |
| DX5 | no | `Reject …`, some still block or await a dispute | no | rejected events; fix lists the rest; close |
| DX6 | no | `Amend the contract` | no | `outcome = amend`; wait; owner item |
| DX7 | no | `Amend the contract` | yes | wait (nothing written) |
| DX8 | no | another choice, after `amend` was applied (an override) | no | apply that choice as DX3–DX10 |
| DX9 | no | `Reassign to g` | no | override `g`; fix to `g`; count 0; close; release the old holder when ready |
| DX10 | no | `Escalate` | no | stop `diagnosis-escalated`; close |

Unreachable combinations:

- A closed diagnosis never reaches the stage: the planner emits it only
  for `diagnosing`, and every close leaves that step in the same
  transaction.
- A free-text decision cannot exist: it is refused at record (decision 6).

**Completeness claim.** The axes are: open or closed; revision past or
not; decision none, applied, or new; and its choice, one of five. Every
combination matches exactly one DX row or one of the two unreachable
claims above.

**Properties** (no new dependency; `mulberry32` from
`src/shared/__tests__/contractFixtures.ts`).

- **P1, one diagnosis per failed round.** Generator: seeded sequences of
  reviews (findings raised, resolved, and reopened on two or three
  clauses), disputes and their decisions, card decisions and owner
  overrides, new task revisions, and a crash at each transaction boundary
  of the open step and of the outcome. Seam: the executor tick over the
  matrix harness with the real `DecisionService`. Property: at most one
  diagnosis row and one card per failed round; at most one fix attempt
  answers a failed round; a closed diagnosis is never re-applied. Seed
  `0xC0FE1D`, 24 executor cases.
- **P2, a signal never decides a finding.** Same generator, at the service
  seam (`findingsLedgerProperties`-style). Property: the multiset of
  finding states differs from the fold without diagnoses only by `rejected`
  events carrying a diagnosis decision id. Seed `0xC0FE1D`, 300 cases.
- **P3, the fix happens iff no diagnosis opens or the outcome sends it.**
  Same executor run. Property: for each failed round, a fix handoff exists
  iff DO says "fix dispatched", or its diagnosis closed by DX1, DX3, DX5, or
  DX9.
- **P4, the signals are pure and shared.** For 300 seeded ledgers,
  `executionView`'s counts equal the `openAfter` values of
  `convergenceWindow(reviewSnapshots(...))`, and the executor's signals
  equal `convergenceSignals` on the same input. Seed `0x5161A1`.

Hazards consulted (`docs/oracle-hazards.md`):

- **M1 (oracle behind a hand-built harness):** V3's DX rows run through the
  production composition, and one row's mutant removes the planner's
  `diagnosis` stage wiring.
- **Several readers on derived state:** P4.
- **B1 (superseded actor):** DX1 and the override rows.
- **The idempotence oracle observing only the unique row:** V3's crash rows
  snapshot every round, attempt, mail, event, and diagnosis row around the
  replay, not only `UNIQUE(round_id)`.

## Risks / Trade-offs

- **[Risk] S3 and S4 overlap, so one card may name both.** → The card lists
  every signal that fired, and the playbook treats them together. The
  overlap is cheap: one card either way.
- **[Risk] A Lead that always answers `Fix round` recreates the old loop.**
  → Each closed diagnosis restarts the window, so a signal needs two or
  three new reviews to fire again. The backstop still fires every `limit`
  failed rounds, and every decision is on the card for the owner to
  override.
- **[Risk] The `Reassign` options come from the plan's own groups, so a
  one-group plan offers none.** → `Escalate` remains, and the owner can
  Retry after amending the plan. A free group choice was rejected because a
  group the plan never named was never checked as routable at Start.
- **[Risk] A diagnosis waiting on `amend` waits on the human
  indefinitely.** → It is an attention item owned by the human, and an
  owner override can choose any other outcome meanwhile.
- **[Trade-off] Rejected findings from a diagnosis bypass the developer's
  dispute.** → That is the outcome's purpose (the contract owner rules them
  out). It is journaled with the decision, and the owner can override it.

## Migration Plan

- The schema is additive:
  - the diagnoses and notices tables;
  - `group_override` on change rows;
  - `max_failed_fix_rounds` on executions, default 5;
  - `kind` on cards, default `'question'`.
- No row is rewritten. Changes stopped as `round-limit` keep that reason,
  and Retry runs their fix as before.
- A running execution picks up the backstop at its default of 5 on upgrade,
  so a change already at 3 or 4 failed fix rounds continues instead of
  stopping.
- Rollback: an older build ignores the new tables and columns. A change
  left in `diagnosing` reads as gating on a failed round, so the old fix
  step dispatches it (at worst one extra fix round).

## Implementation contract

### Acceptance

- A1: `convergenceSignals` and `convergenceWindow` give exactly the
  outcomes of tables SG and WN for each row.
- A2: At the fix step, a failed round opens a diagnosis, or dispatches its
  fix, exactly as table DO says, and never opens a second diagnosis for the
  same round.
- A3: The diagnosis stage writes exactly what table DX says for each row,
  through the production executor composition.
- A4: A diagnosis card is asked by Kawai, addressed to the Lead role (else
  the owner), carries the options in the spec's order with `Reject` naming
  at most ten blocking findings, refuses free-text choices from agents and
  the owner, and sends no answer mail.
- A5: An open diagnosis reads stalled as `convergence` before any other
  stall, its card's message is the episode's only `plan-stall` message, and
  a structured review adds nothing to `failureSignature`.
- A6: The attention queue shows one item for a convergence stall (the
  card's), and after `Amend the contract` one human item, **Publish a task
  revision**.
- A7: `planExecution.maxFailedFixRounds` is parsed as an integer from 2 to
  20 (default 5), recorded at Start, and read by the backstop; no code path
  writes the `round-limit` stop.
- A8: Retry of a `diagnosis-escalated` or `round-limit` change dispatches a
  fix with the count starting at one.
- A9: The Plans view's change row shows the open counts by review of the
  window, and the open diagnosis's signals.
- A10: A counted review on a task that no execution owns, which makes a
  signal fire, writes one journal entry and at most one system message to a
  session creator, and nothing else, once per submission.
- A11: `lead.md`, `change-leads.md`, and `reviewers.md` no longer contain
  the two-correction-rounds rule. `docs/agent-collaboration.md`'s "Review
  protocol" defines the convergence playbook once, and the prompts point at
  it.

### Invariants

- I1: No signal or diagnosis changes a finding's state, a round's outcome,
  or a derived verdict. Only a recorded diagnosis decision writes
  `rejected` events, and those events name it.
- I2: A failed round has at most one diagnosis and at most one fix attempt
  answering it, across crashes and restarts.
- I3: Every reader of the signals or the window calls the one pure module.
- I4: No agent publishes a task revision. `Amend the contract` only waits
  for the owner's revision.
- I5: A closed diagnosis is never applied again. A later decision or
  override on its card only journals and creates its forward-fix task.

### Scope

- `src/shared/reviewConvergence.ts`
- `src/shared/planExecution.ts`
- `src/shared/planExecutionProgress.ts`
- `src/shared/planSupervision.ts`
- `src/server/team/planAttention.ts`
- `src/shared/planDecisions.ts`
- `src/server/plans/execution/**`
- `src/server/plans/supervision/**`
- `src/server/plans/decisions/**`
- `src/server/team/TaskFindingService.ts`
- `src/server/team/TaskResultService.ts`
- `src/server/team/findingStore.ts`
- `src/server/team/teamCaps.ts`
- `src/server/plans/planComposition.ts`
- `src/client/components/team/PlanExecutionChangeRow.tsx`
- `src/client/components/team/planLabels.ts`
- `src/server/__tests__/**`
- `src/shared/__tests__/**`
- `src/client/__tests__/**`
- `tests/e2e/**`
- `.kawai/groups/lead.md`
- `.kawai/groups/change-leads.md`
- `.kawai/groups/reviewers.md`
- `docs/agent-collaboration.md`
- `docs/architecture/plan-execution.md`
- `docs/architecture/plan-supervision.md`
- `docs/recovery-matrix.md`
- `openspec/changes/review-convergence/**`

### Verification

- V1: Tables SG and WN are committed verbatim as table-driven tests in
  `src/shared/__tests__/reviewConvergence.test.ts`.
- V2: Table DO's rows run as table-driven tests at the executor seam over
  the matrix harness. Each row asserts the stored rounds, attempts,
  diagnoses, cards, and mail.
- V3: Table DX's rows run through the production executor composition with
  the real `DecisionService`, including a crash after the dispatch and
  before the close (DX3, DX5, DX9). Each crash row snapshots every round,
  attempt, mail, ledger event, and diagnosis row around the replay.
- V4: Properties P1 to P4 run with their seeds and case counts in
  `*.integration.test.ts` files.
- V5: A client test of `PlanExecutionChangeRow` renders the counts and the
  signals, and a Playwright spec opens a diagnosis in the fixture plan and
  sees the convergence stall, the card, and the count line.
- V6: `docs/recovery-matrix.md` gains three rows, each citing its test:
  - a crash in the open step;
  - a decision committed but its outcome not applied;
  - an `amend` wait across a restart.

  `recoveryMatrix.test.ts` passes.
- V7: `src/shared/__tests__/reviewProtocolDocs.test.ts` asserts A11.
- V8: Every ADDED and MODIFIED scenario of this change's delta specs has a
  `@covers` annotation. `specCoverageGuard.test.ts` and `bun run check`
  pass.

### Excluded

- X1: No new finding field (no `conflicts_with`), and no change to the
  gate, the fold, dispositions, or disputes.
- X2: No change to `team-workspace-redesign` or its `rework-stuck` item.
- X3: No signal display in the Task view's findings section.
- X4: No agent-side tool to publish or propose a task revision.
- X5: No `Reassign` to a group the execution's plan revision does not name.
