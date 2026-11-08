# Design

## Context

See proposal.md, "Why". The current state that shapes the approach:

- `task_submit_findings` (`src/server/team/taskTools.ts`) takes
  `{ result_id, kind, verdict, findings: string }`.
  `TaskResultService.submitFindings` writes one `team_task_findings` row:
  free text and a verdict, with `handoff_id` set when the caller is the
  claimant of the outstanding handoff for that result.
- `reviewVerdict` (`src/shared/planExecutionGates.ts`) counts the newest
  row from the review handoff's current claimant on the round's result.
  `decideVerdict` (`executionRounds.ts`) fails or passes the round with
  `verdict_findings_id`.
- The fix instruction (`instructions.ts`, `fixInstruction`) joins the
  counted rows' text and cuts it at `LIST_CHARS` (600). Three callers build
  it: `executor.ts` (the fixes step), `dispatchOwedFix`, and the republish
  path in `executionRounds.ts`.
- `implementation-contract` (archived 2026-11-08) gives every task revision
  an identity `r<N>#<hash12>`, clauses `A*`/`I*`/`V*`/`X*`, scope globs, and
  a result scope fact (`ResultCheckFacts.scope`) whose `outside` list names
  changed paths outside scope, at most 20, with a `more` count.
- Decision cards (`src/server/plans/decisions/`) need a `plan_id` and an
  `asked_by_session`. They route to the Lead role, else to the owner.
  Supervision already reads a change as waiting on an open card.
- Readers of the verdict besides execution: `taskStore.ts`
  (`reviewVerdict` of the outstanding result), `teamTaskStage.ts`,
  `planWorkspaceRuntime.ts`, `attentionAcceptance.ts`, and
  `workspaceRead.ts`. They read the row's `verdict` column.

## Goals / Non-Goals

**Goals:**
- One pure fold derives the ledger, the verdict, and the blocking set.
  Every reader (the tools, execution, the client) calls it, so they cannot
  disagree (oracle-hazards, "Several readers disagreeing on derived state").
- Every verdict reader sees the effective verdict, the fold's
  `deriveVerdict` for a structured row at read time, never the stored
  column. The column records the verdict at submission, for the journal
  and metrics. The five readers all take `reviewVerdict` from
  `taskStore.ts`'s task summary, so that one projection serves them all.
- No fix round is spent on a refuted finding.

**Non-Goals:**
- Convergence signals, DIAGNOSE, and changes to the three-round stop
  (`review-convergence`).
- Per-finding metrics. `delivery-outcome-metrics` keeps counting review
  rounds from `team_task_findings` rows, which stay one per submission.
- Editing or deleting a submitted finding. A correction is a new
  submission on the same result, before it is final.

## Decisions

### D1 — Settled open questions

- **Rebuttal is a separate tool, `task_dispute_findings`.** A result field
  would force a new commit, which supersedes the round and spends a fix
  round. That defeats the purpose. A dispute needs no commit.
- **Locus is the clause plus the path of the first `file:line`** in the
  evidence (`parseLocus`: the first match of
  `(?:^|\s|\()([\w./-]+\.[\w]+):\d+`, normalized by stripping a leading
  `./`). Line numbers are ignored because fixes move lines. Evidence
  without a path has the empty locus, so it matches only other path-less
  findings on the same clause.
- **An unsupported P0 sends no alert.** Alerting on claims without
  evidence would reward claims without evidence. The tool's reply tells the
  reviewer what is missing, and a corrected submission is allowed while
  the review is not final (D5).
- **P0 escalation is a `review-p0` message, not a card.** An accepted P0
  leaves nothing for the Lead to decide: the fix proceeds either way, and
  only the owner can stop a change. A card that has no decision would sit
  open and read as a supervision wait. The proposal's "Lead card" bullet is
  amended to match. This default is still to be confirmed with the owner
  at plan review.

### D2 — Shared model: `src/shared/reviewFindings.ts`

The module is pure and imports nothing from the server:

- Types: `FindingLevel = 'P0'|'P1'|'P2'`. `FindingClass` is one of
  `accepted`, `unsupported`, `advisory`, `out-of-contract`. `FindingState`
  is the class plus `disputed`, `rejected`, `resolved`, `still-open`,
  `reopened`, and `superseded`. A `LedgerRow` has an id, level, clause,
  state, locus, `regressed`, and `transitions[]`.
- `resolveCitation(citation, ctx)` (table CR), then
  `classifyFinding(input, ctx)` (table GT): the gate.
  `ctx = { contract | null, identity, scopeFact | null, linkedChange }`.
  It reuses `implementationContract.ts` to resolve clauses. Scope matching
  goes through an injected `matchesScope(path)`, because `Bun.Glob` is
  server-only (implementation-contract D6).
- `foldLedger(submissions, events)`: submissions are the counted ones
  (D5), events are those of D3, and both are ordered by `ledgerSeq`. It
  returns the rows. `blocking(rows)` returns the rows in state `accepted`,
  `still-open`, or `reopened` at P0/P1. `pendingDisputes(rows)` returns
  the `disputed` rows.
- `deriveVerdict(rows) = blocking(rows).length > 0 ? 'fail' : 'pass'`, and
  `roundReview(rows) = fail | pending-dispute | pass` (table RD).

### D3 — Storage

The next free numbered migration (coordinate with in-flight migrations, as
`lead.md` requires) adds:

- `team_task_findings.structured INTEGER NOT NULL DEFAULT 0`,
  `counted INTEGER NOT NULL DEFAULT 0` (D5's test, fixed at submission),
  `contract_identity TEXT`, `ledger_seq INTEGER`, `replaced_by TEXT`. A
  structured row's `findings` text holds the reviewer's optional notes, or
  a rendered summary (`3 findings: F1 accepted P1 …`). `verdict` holds the
  derived verdict.
- `team_task_finding_items`: `(id PK, submission_id, task_id, finding_id,
  item_kind 'finding'|'disposition', level, clause, clause_id, evidence,
  impact, reproduction, locus, class, reason, disposition, regressed,
  created_at)`, with `UNIQUE(submission_id, finding_id)` and an index on
  `(task_id, finding_id)`.
- `team_task_finding_events`: `(id PK, task_id, finding_id, ledger_seq,
  kind 'disputed'|'upheld'|'rejected'|'remapped'|'superseded'|'ignored',
  result_id, card_id, decision_id, revision, contract_identity, clause,
  actor_kind, actor_session, text, source_key UNIQUE, created_at)`.
  `source_key` makes every Kawai-written event replay-safe:
  - `decision:<decisionId>` for a card decision;
  - `revision:<taskId>:<revision>:<findingId>` for a re-map;
  - `dispute:<submissionId>:<findingId>:<n>` for a dispute.
- `team_task_finding_cards`: `(card_id PK, task_id, finding_id,
  dispute_event_id UNIQUE)`.
- `plan_execution_rounds.regate_of TEXT` with a partial unique index (D8;
  SQLite cannot add a UNIQUE column).

`ledger_seq` is allocated per task as `max+1` across both tables, inside
the writing `BEGIN IMMEDIATE` transaction. Finding ids are allocated the
same way (`F` + (max over items + 1)), so ids are monotonic and never
reused, even for submissions that do not count. No backfill: old rows read
`structured = 0` and have no ledger rows.

### D4 — Submission (`TaskFindingService.submit`)

`TaskResultService.submitFindings` keeps its refusals (system caller,
agent only, same team, result of the task, and the revision-control D9
ownership check, B1). It then delegates a structured submission to
`TaskFindingService.submit`, inside one transaction:

1. Bounds (spec "Submissions are bounded"): at most 30 new findings and
   50 dispositions per submission, and at most 50 blocking findings per
   task after it. The disposition bound equals the blocking cap, so a
   verify round can always dispose of every blocking finding. A refusal
   writes nothing.
2. Does the submission count, and is the result final (D5)?
3. Build the prior ledger, which is the fold without any earlier counted
   submission on this result. Every disposition must name a blocking
   finding; every blocking finding must have a disposition (table VD). A
   new item that duplicates a blocking finding is refused (table RO).
4. Resolve reopen matches (RO), assign ids, and classify the new items
   (GT) against the pinned revision's contract and the result's scope fact
   as read at that moment.
5. Derive the verdict and refuse a contradicting `verdict` argument.
6. Write the row, the items, and `ledger_seq`; mark a replaced submission
   `replaced_by`; journal one line.

The reply lists each item's id, class, and reason, the derived verdict,
and whether the submission counts. The tool schema gains
`items?: [{ id?, level, clause?, evidence?, impact?, reproduction? }]`,
`dispositions?: [{ id, disposition, evidence? }]`, an optional `verdict`,
and optional `findings` (notes). Text-only submissions keep requiring
`verdict`. Text-only submissions from the review handoff's claimant on a
plan change's task are refused (spec plan-execution).

### D5 — What counts, and finality

`countsForLedger(row, task)`: on a plan change's task, `handoff_id` must
be the review handoff (the existing `answers` test); otherwise any
structured row counts. A counted submission on result R is final when:

- an event names one of its findings;
- a counted submission exists on a newer result; or
- a decided round has R as its `result_id`.

Then a new counted submission on R is refused, naming the reason. A
non-counted submission is always accepted and shown as not counted.
Finality makes replacement safe: no event can sit between a replaced
submission and the one that replaces it, so the fold may drop the
replaced row wherever it falls.

**The effective verdict.** `effectiveVerdict(row, fold)` is the stored
`verdict` for a text-only row. For a structured row it is
`deriveVerdict(fold)`, with the fold taken over every counted submission
and event up to now. `taskStore.ts`'s summary (`reviewVerdict` of the
outstanding result) uses it, so `teamTaskStage.ts`,
`planWorkspaceRuntime.ts`, `attentionAcceptance.ts`, and
`workspaceRead.ts` read the same value as execution. Rejecting the only
blocking finding turns "Fixes requested" back into "Awaiting acceptance"
without touching the row. A pending dispute with nothing blocking reads
`pass` there, and the attention queue lists the dispute itself (D6).

`reviewVerdict` (`planExecutionGates.ts`) is unchanged. It still picks the claimant's newest row on
the round's result, and for structured rows that is exactly the counted
submission. `decideVerdict` then reads `roundReview(fold)` instead of the
row's verdict, because disputes can move a row's outcome after it is
written.

### D6 — Disputes and decisions

`task_dispute_findings { task_id, disputes: [{ id, counter_evidence }] }`.
The caller must have authored a result of the task and pass the ownership
check (B1). The findings must be blocking, with no prior dispute in their
current state entry (table DS). Each dispute writes a `disputed` event.

- **Plan tasks.** In the same transaction Kawai creates one card per
  finding through `DecisionService`'s internal ask path, so a dispute and
  its card commit together. The card is asked by the disputer, routed as
  its questions are, and records a `team_task_finding_cards` row. The
  options are `Uphold F<n>` and `Reject F<n>`, and the context is the
  evidence and the counter-evidence, each cut at 1,000 characters.
- **Other tasks.** Kawai journals the dispute and sends the creator one
  message when the creator is an agent session. For a human creator, the
  Team page attention queue lists it.

`DecisionService` gains a post-commit hook: for every decision or
override on a linked card it calls `applyCardDecision`. Whether the
decision applies depends on the finding's history since the card's own
dispute event, not on whether the finding still reads `disputed`:

- It applies when every event and disposition on the finding after the
  dispute event came from this same card (its earlier decision, or none
  yet). That covers the first decision (DD1, DD2) and every owner
  override of it (DD3, DD4): the finding moves to `upheld` or `rejected`
  again, under `decision:<id>`.
- It is `ignored` when anything else has touched the finding since the
  dispute: a re-map (`remapped` or `superseded`), a disposition in a later
  review, or a newer dispute with its own card (DD5, DD7). The decision
  stays on the card, and the owner's override still creates its
  forward-fix task as for any card.

A startup pass replays the hook for linked cards whose current decision
has no event (recovery matrix row). `task_decide_dispute { task_id, finding_id, decision,
rationale }` is the non-plan path: creator or human only, and refused on
plan tasks, whose card is the only path.

### D7 — Instructions

`fixInstruction` takes
`findings: { blocking: LedgerRow[], others: number, legacyTexts: string[] }`.
Each blocking row renders as
`F3 (P1, r2#… › A1): <evidence> — repro: <reproduction>`, with evidence
and reproduction each cut at 600 characters and the block cut at 4,000
characters, with the `task_get` pointer. Then comes the line
`N other findings (advisory, unsupported, out of contract) are in
task_get; they are not required`. Then:
`Fix only the listed ids with minimal changes. If you can refute one with
evidence, dispute it with task_dispute_findings instead of changing code.`
`legacyTexts` keeps today's rendering, for a round decided on a text row
before the upgrade.

The three callers get one shared builder,
`fixFindings(deps, round) → FixInstructionInput['findings']`, which reads
the fold. The manifest keeps `findingsIds` as the counted submission id.
The review handoff text (executionRounds.ts:463) gains the contract
identity, the blocking ids with their clauses, and the disposition rule.

### D8 — Round verdict, holds, and re-gate

`decideVerdict` maps `roundReview` (table RD): `fail` fails the round as
today; `pending-dispute` returns, leaving the round waiting; `pass` passes
it. The executor already re-ticks on task writes (`onWrite`). Decision
events call `onWrite`, so a waiting round re-decides when its last dispute
is decided.

Re-gate is a new executor step, `regateRefuted`, keyed by
`regate_of = <failed round id>`. Its guard needs every one of these:

- the change's newest round failed on its review alone (its CI passed);
- the change has no newer result;
- the round's result is pinned to the task's current revision. A result
  pinned to an older revision never passes a round, as the existing
  plan-execution rule requires;
- every finding that was blocking when the round failed now reads
  `rejected`, by a decision on its own dispute. A finding that left the
  blocking set any other way (`superseded` by a re-map, `resolved` by
  nothing, since no newer review exists) does not count as refuted;
- the fold has no blocking and no disputed finding;
- the fix attempt is outstanding.

The round's blocking set is recorded when it fails: `decideVerdict`
stores the blocking ids in the round's `extra_json` (`blockingIds`), so
the guard never re-derives them from a later fold.

The step inserts a round with the same `result_id`, `commit_sha`, CI
rows, `review_assignment_id`, and `verdict_findings_id`, and decides it
pass. It settles the outstanding fix handoff as answered by that round,
mails the implementer, and journals. The UNIQUE column makes the step run
at most once. A crash before the insert re-runs it on the next tick or at
startup, and a crash after the insert finds the row (matrix row).

### D9 — Re-map on publication

In the publication transaction (`TaskService`), when the new revision's
identity hash (the part after `#`; the `r<N>` prefix moves on every
publication) differs from the previous one's, Kawai writes `remapped` or
`superseded` for each blocking or disputed finding (table RM) under
`revision:` keys. It journals one line per finding. A replayed publication
writes nothing new. A contract is never removed once published, so RM5
is reachable only in the pure model; the table keeps it for completeness.

### D10 — Alerts, reads, and client

- **`review-p0` alerts.** `decideVerdict`, when it fails a round with
  accepted P0 items in the counted submission, sends one message per
  finding through the plan-stop alert path (`supervision/stopAlerts.ts`,
  keyed `review-p0:<roundId>:<findingId>`). With no Lead role it records a
  plan event instead.
- **Reads.** `task_get` gains `findingsLedger: LedgerRow[]` (bounded to
  100 rows, newest first, with `ledgerOlderRemaining`) and
  per-submission `items` with class and counted flag. The delivered task
  header gains one line: `Findings: 2 blocking (F1, F3), 1 disputed (F4)`.
- **Client.**
  - `TeamTaskDetail` gets a Findings section: rows, states, and expandable
    transitions. For a non-plan task's creator or the human it adds
    Uphold/Reject with a rationale.
  - The result card shows each item's class, or not counted.
  - The text rendering of unstructured rows is kept.

### D11 — Prompts and docs

- `reviewers*.md`: the finding format, levels, the clause rule, the
  evidence rule, verify-round dispositions, and "P2 never blocks". The
  scattered blocking and oracle rules are removed.
- Dev role files: "fix only listed ids, minimally; dispute with evidence".
- `lead.md` and `change-leads.md`: deciding dispute cards, and `review-p0`.
- `docs/agent-collaboration.md`: a new "Review protocol" section.
- `docs/oracle-hazards.md`: points blocking rules to it.
- `docs/architecture/`: the team-tasks bullet.

## Acceptance oracles

### Gate, step 1: citation resolution — table CR (`resolveCitation`)

The citation is resolved before any evidence or scope check, so the
no-contract fallback can never be shadowed by a clause lookup.

| | Citation | Pinned revision | Resolves to |
|---|---|---|---|
| CR1 | absent | * | out-of-contract (no clause) |
| CR2 | the pinned revision's identity, alone | no contract | whole-revision citation |
| CR3 | the pinned revision's identity, alone | has a contract | out-of-contract (cite a clause) |
| CR4 | another revision's identity, alone or with a clause | * | out-of-contract (stale identity) |
| CR5 | a clause id, bare or full | no contract | out-of-contract (no clauses) |
| CR6 | a clause id present, `X*` | has a contract | out-of-contract (excluded) |
| CR7 | a clause id present, `A*`/`I*`/`V*` | has a contract | that clause |
| CR8 | a clause id not in the contract | has a contract | out-of-contract (unknown clause) |
| CR9 | bare `A1`, present | has a contract | the clause, stored as its full identity |

Every citation matches exactly one row: the rows partition on (form of the
citation, whether its identity is the pinned one, whether the pinned
revision has a contract, whether the id exists, the id's part).

### Gate, step 2: classification — table GT (`classifyFinding`)

| | Level | Resolved citation | Evidence | Impact | Evidence paths | Class |
|---|---|---|---|---|---|---|
| GT1 | P2 | * | * | * | * | advisory |
| GT2 | P0/P1 | out-of-contract (CR1, CR3–CR6, CR8) | * | * | * | out-of-contract, with CR's reason |
| GT3 | P0/P1 | clause or whole revision | absent | * | — | unsupported (evidence) |
| GT4 | P0/P1 | clause or whole revision | present | absent | * | unsupported (impact) |
| GT5 | P0/P1 | whole revision (CR2) | present | present | * (no scope to judge) | accepted |
| GT6 | P0/P1 | clause | present | present | none | accepted |
| GT7 | P0/P1 | clause | present | present | ≥1 in scope or under `openspec/changes/<change>/` | accepted |
| GT8 | P0/P1 | clause | present | present | all outside scope, ≥1 in fact `outside` | accepted |
| GT9 | P0/P1 | clause | present | present | all outside scope, none in `outside`, fact `more = 0`, status known | out-of-contract (scope) |
| GT10 | P0/P1 | clause | present | present | all outside scope, fact unknown, absent, or `more > 0` | accepted |

The rows partition the inputs: level, then the resolved citation, then
evidence, impact, and paths. No two rows overlap, so row order does not
matter. Unreachable: a P2 with a class other than advisory, because the
level alone decides it, and a whole-revision citation reaching a scope
row, because a revision without a contract has no scope.

### Verify-round dispositions — table VD

| | Prior blocking | Dispositions given | New items | Outcome |
|---|---|---|---|---|
| VD1 | none | none | none | pass |
| VD2 | {F2} | F2 resolved | none | F2 resolved; pass |
| VD3 | {F2} | F2 still-open + evidence | none | F2 still-open; fail |
| VD4 | {F2} | F2 regressed + evidence | none | F2 still-open, regressed; fail |
| VD5 | {F2, F3} | F2 only | * | refused naming F3 |
| VD6 | {F2} | F2 still-open, no evidence | * | refused naming F2's evidence |
| VD7 | {} | F9 resolved | * | refused: F9 is not blocking |
| VD8 | {F2}, F4 disputed | F2 resolved | none | pass (pending-dispute at round level) |
| VD9 | {F2} | F2 resolved | accepted P1 F5 | fail on F5 |
| VD10 | {F2} | F2 resolved, F2 resolved | * | refused: duplicate disposition |

### Reopen and duplicates — table RO

| | Existing | New item (clause, locus) | Result |
|---|---|---|---|
| RO1 | F2 resolved (A1, `src/a.ts`) | (A1, `src/a.ts`) | F2 reopened, re-gated by GT |
| RO2 | F2 resolved (A1, `src/a.ts`) | (A1, `src/b.ts`) | new id |
| RO3 | F2 resolved (A1, ``), no path | (A1, ``) | F2 reopened |
| RO4 | F2 blocking (A1, `src/a.ts`) | (A1, `src/a.ts`) | refused naming F2 |
| RO5 | F2 resolved at seq 5, F6 resolved at seq 9, both (A1, `src/a.ts`) | (A1, `src/a.ts`) | F6 reopened |
| RO6 | F2 and F6 resolved at the same seq | match | F2 (lowest id) |
| RO7 | F2 rejected (A1, `src/a.ts`) | (A1, `src/a.ts`) | new id (rejected never reopens) |
| RO8 | F2 superseded | match | new id |
| RO9 | item with explicit `id: F2`, F2 resolved | any | F2 reopened |
| RO10 | item with explicit `id: F99`, unknown | any | refused naming F99 |

A reopened finding that GT does not accept records its class. It is not
blocking, and the transition still shows the re-raise.

### Disputes — table DS

| | Caller | Finding state | Prior dispute in this state | Outcome |
|---|---|---|---|---|
| DS1 | author of a result | accepted / still-open / reopened | no | disputed |
| DS2 | author | any blocking | yes (upheld) | refused naming the id |
| DS3 | author | advisory / unsupported / out-of-contract / resolved / rejected / superseded | * | refused: not blocking |
| DS4 | author | disputed | * | refused: already disputed |
| DS5 | non-author | * | * | refused |
| DS6 | author replaced by a Restart (B1) | * | * | refused by the ownership check |
| DS7 | author | blocking, 11 disputes in one call | * | refused naming the limit of 10 |

Decisions:

| | Card or decision | Finding now | Event | Finding after |
|---|---|---|---|---|
| DD1 | Uphold | disputed by this card | upheld | the state before the dispute |
| DD2 | Reject | disputed by this card | rejected | rejected |
| DD3 | owner override Reject→Uphold | rejected by this card's decision | upheld | the state before the dispute |
| DD4 | owner override Uphold→Reject | blocking again by this card's decision | rejected | rejected |
| DD5 | any | superseded or remapped after the dispute | ignored | unchanged |
| DD6 | replay of the same decision id | * | none (source_key) | unchanged |
| DD7 | owner override | a later review disposed of it, or a newer dispute has its own card | ignored | unchanged; the forward-fix task carries the override |

"By this card" means every event on the finding since the card's dispute
event came from this card. That is the hook's one test, so DD3 and DD4
apply and DD5 and DD7 do not.

### Round review — table RD (`roundReview` and `decideVerdict`)

| | Blocking after counted submission | Disputed | Round CI | Outcome |
|---|---|---|---|---|
| RD1 | ≥1 | * | passed | fail |
| RD2 | 0 | ≥1 | passed | waits (pending-dispute) |
| RD3 | 0 | 0 | passed | pass |
| RD4 | — | — | failed | fail on CI, no review (unchanged) |

Re-gate guard (`regateRefuted`). "Round's blockers" are the ids recorded
in the failed round's `blockingIds`:

| | Newest round | Failed on | Newer result | Result pin | Round's blockers now | Fold: blocking / disputed | Fix attempt | Action |
|---|---|---|---|---|---|---|---|---|
| RG1 | failed | review only | no | current | all rejected by their disputes | 0 / 0 | outstanding | new passing round, attempt answered |
| RG2 | failed | review only | no | current | some still disputed | 0 / ≥1 | outstanding | none (wait) |
| RG3 | failed | review only | yes | * | * | * | * | none (the newer result gates) |
| RG4 | failed | CI | * | * | * | * | * | none |
| RG5 | failed | review only | no | current | some upheld | ≥1 / * | * | none |
| RG6 | already has a `regate_of` row | * | * | * | * | * | * | none (UNIQUE) |
| RG7 | passed or superseded | * | * | * | * | * | * | none |
| RG8 | failed | review only | no | current | some rejected, the rest superseded by a re-map | 0 / 0 | outstanding | none: a superseded finding was not refuted |
| RG9 | failed | review only | no | older revision | all rejected | 0 / 0 | outstanding | none: an older-revision result never passes |
| RG10 | failed | review only | no | current | all rejected | 0 / 0 | answered or none | none |

### Re-map — table RM

| | Finding cites | New revision | Event |
|---|---|---|---|
| RM1 | `r2#… › A1` | contract has A1 | remapped to `r3#… › A1`, state kept |
| RM2 | `r2#… › A5` | contract lacks A5 | superseded |
| RM3 | revision identity `r2#…` | no contract | remapped to `r3#…` |
| RM4 | revision identity | has a contract | superseded |
| RM5 | `› A1` | no contract | superseded |
| RM6 | any | same identity (contract unchanged) | none |
| RM7 | finding not blocking or disputed | * | none |

### Properties

All properties use a fixed seed `0xF1ED6E5` and 300 cases, with no new
dependency.

- **P1, one reader.** For seeded sequences of submissions, disputes,
  decisions, and revisions run through the production services against a
  real store, the ledger that `task_get` returns, the verdict column of the
  outstanding result's effective verdict in the task summary,
  `decideVerdict`'s outcome, the derived task stage, and the client's
  rendering input all come from one `foldLedger` result. They agree after
  every command, including a dispute decision that writes no submission. The seam is the
  real `TaskResultService`/`TaskFindingService` and executor tick, not a
  hand-built harness (M1).
- **P2, ids.** Ids are unique per task, strictly increasing in allocation
  order, and never reused, across replaced and non-counted submissions.
- **P3, replay.** Replaying every Kawai-written event (decision hook,
  re-map, re-gate) after a simulated crash at each transaction boundary
  yields the same ledger and at most one re-gate round per failed round.
  The check covers every row class, not only the uniquely keyed one.
- **P4, monotone blocking.** A finding leaves the blocking set only by
  `resolved`, `rejected`, `superseded`, or `disputed`, and enters it only
  by `accepted`, `still-open`, `reopened`, or `upheld`.

## Implementation contract

### Acceptance
- A1: `task_submit_findings` takes structured findings and dispositions,
  classifies them per tables CR and GT, derives the verdict, and enforces the
  bounds and rows VD1-VD10 and RO1-RO10.
- A2: The ledger is stored per D3 and derived by one fold; `task_get`, the
  task header, the task detail, and the result card show it, and old
  text-only rows still read as unstructured.
- A3: `task_dispute_findings` and `task_decide_dispute` implement rows
  DS1-DS7 and DD1-DD7, and plan tasks get one decision card per disputed
  finding.
- A4: Plan rounds decide per table RD, refuted reviews re-gate per rows
  RG1-RG10, and the fix instruction lists only blocking findings per D7.
- A5: A new task revision re-maps open findings per rows RM1-RM7.
- A6: An accepted P0 sends one `review-p0` alert per finding per round.
- A7: The role files and docs listed in D11 describe the protocol.

### Invariants
- I1: Only P0/P1 findings in state accepted, still-open, or reopened fail
  a round or a derived verdict.
- I2: Every reader derives the ledger and the effective verdict through
  `foldLedger`; none re-implements state or reads a structured row's
  stored verdict as current.
- I3: A refused submission, dispute, or decision writes nothing.
- I4: Existing `team_task_findings` rows are never rewritten; text-only
  rows keep their verdict.
- I5: Every Kawai-written event and the re-gate round are replay-safe
  under their unique keys.
- I6: No new runtime dependency.

### Scope
- `src/shared/**`
- `src/server/team/**`
- `src/server/plans/execution/**`
- `src/server/plans/decisions/**`
- `src/server/plans/supervision/**`
- `src/server/dbSafety/migrations.ts`
- `src/server/__tests__/**`
- `src/client/components/team/**`
- `src/client/stores/**`
- `.kawai/groups/**`
- `docs/**`
- `tests/e2e/**`

### Verification
- V1: `bun run check` passes on the clean committed tree.
- V2: Every table row and property above is a named test whose title
  starts with its oracle id, through the production services.
- V3: Every ADDED or MODIFIED scenario has an `@covers` annotation.
- V4: The recovery matrix has rows for the decision-hook replay and the
  re-gate, and `recoveryMatrix.test.ts` passes.
- V5: A Playwright walkthrough shows a structured review, a dispute, its
  decision, and the ledger in the task detail.

### Excluded
- X1: Convergence signals, DIAGNOSE, and the fix-round stop
  (`review-convergence`).
- X2: Per-finding metrics or changes to `delivery-outcome-metrics`.
- X3: Changes to `reviewVerdict`'s claimant and author rules.
- X4: Editing or deleting submitted findings.

## Risks / Trade-offs

- [The scope fact may not exist yet at submission, since result checks run
  asynchronously] → GT10 treats unknown as in bounds, so a finding is
  never dropped on uncertainty. The class is fixed at submission, so a
  later fact does not reclassify it.
- [Finality makes a plan reviewer's first submission final as soon as the
  round decides] → This is the same as today, where the first counted
  verdict decides. The reply lists every class, so a reviewer sees an
  unsupported P1 before it matters only if they read it. The prompts say
  to read it.
- [A dispute-only fix attempt can wait a long time on a card] → The card
  is a normal supervision wait, so stall alerts apply as for any open
  card.
- [The locus rule is coarse: two real defects under one clause in one
  file] → The reviewer gives the second one a new finding while the first
  is not blocking. While the first is blocking, RO4 refuses the second and
  asks for a disposition of the first, which keeps the same defect from
  being double-counted.
- [Text-only submissions on manual tasks never enter the ledger] → This is
  intended for compatibility, and the prompts move every reviewer to the
  structured form.

## Migration Plan

- One additive migration (D3) with no backfill. Rollback is the database
  backup the migration runner writes before migrating. A downgraded build
  ignores the new columns and tables.
- Rounds decided before the upgrade keep their text rows, and
  `fixFindings` falls back to `legacyTexts` for them.
- Prompts and the Kawai build ship in the same PR, so reviewers never see
  the structured-only refusal without the prompt that describes it.

## Open Questions

- The owner's confirmation of D1's P0 default (message, not card). If the
  owner wants a card, only D10's alert sender and its spec requirement
  change. The ledger, gate, and rounds stay as they are.
