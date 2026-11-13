# review-findings Specification

## Purpose

Defines structured review findings: their ids, levels, clause citations, and
evidence; the mechanical gate that decides which findings can fail a round;
the developer's dispute of a finding and its decision; the per-task findings
ledger; and the dispositions a verify round gives every finding still open.

## Requirements

### Requirement: A finding has an id, a level, a clause, and evidence
A structured finding SHALL have a level `P0`, `P1`, or `P2`, and MAY have a clause citation, evidence, an impact, and a reproduction. Kawai SHALL assign each new finding the next id `F<n>` of its task, starting at `F1` and never reused. A clause citation SHALL be a clause id of the result's pinned contract or its full clause identity; on a revision without a contract it SHALL be the revision's identity.

#### Scenario: Kawai numbers new findings
- **WHEN** a task's first review submits two findings without ids, and a later review of the same task submits one more
- **THEN** they are `F1` and `F2`, and the later one is `F3`

#### Scenario: A bare clause id resolves against the pinned revision
- **WHEN** a finding on a result pinned to revision 3, whose identity is `r3#4f1c09ab22de`, cites `I2`
- **THEN** the finding records the clause `r3#4f1c09ab22de › I2`

#### Scenario: A citation of another revision's identity
- **WHEN** a finding on a result pinned to revision 3 cites `r2#0a1b2c3d4e5f › A1`
- **THEN** the finding is recorded as out of contract, naming the stale identity

### Requirement: Submissions are bounded
A submission SHALL hold at most 30 new findings and 50 dispositions, and SHALL NOT leave the task more than 50 blocking findings. A finding's evidence and reproduction SHALL each be at most 4,000 characters, its impact at most 1,000, and a clause citation at most 200. A submission over a bound SHALL be refused naming the bound, with nothing written.

#### Scenario: Too many findings
- **WHEN** a reviewer submits 31 findings for one result
- **THEN** the submission is refused naming the limit of 30, and no finding or verdict is recorded

#### Scenario: Too many blocking findings
- **WHEN** a task has 30 blocking findings, and a verify review disposes of all 30 as still-open and adds 21 accepted findings
- **THEN** the submission is refused naming the cap of 50 blocking findings, and nothing is written

#### Scenario: Every blocking finding can be disposed of
- **WHEN** a task has 50 blocking findings
- **THEN** one verify review can give all 50 dispositions within the bounds

### Requirement: The gate classifies every finding mechanically
At submission Kawai SHALL classify each new finding once and store the class with its reason: `advisory` for P2; `out-of-contract` for a P0/P1 citing no clause of the pinned revision, citing an `X*` clause, or whose evidence names only paths that are neither in scope nor changed by the result; `unsupported` for a P0/P1 missing evidence or impact; `accepted` otherwise.

#### Scenario: A complete P1 is accepted
- **WHEN** a P1 cites A2 of the pinned contract, with evidence `src/server/team/taskStore.ts:88` inside scope and an impact
- **THEN** it is classified accepted

#### Scenario: A P1 without evidence
- **WHEN** a P1 cites A2 and states an impact but gives no evidence
- **THEN** it is classified unsupported, naming the missing evidence

#### Scenario: A finding on an excluded clause
- **WHEN** a P0 cites X1 of the pinned contract
- **THEN** it is classified out of contract, naming X1

#### Scenario: Evidence only outside scope
- **WHEN** a P1 cites A1 and its only evidence path is `src/client/App.tsx`, which matches no scope glob and is not changed by the result
- **THEN** it is classified out of contract, naming the path

#### Scenario: An out-of-scope path the result changed
- **WHEN** a P1 cites I1 and its only evidence path matches no scope glob, but the result's scope fact lists that path as changed outside scope
- **THEN** it is classified accepted

#### Scenario: Scope cannot be judged
- **WHEN** a P1 cites A1 with an evidence path outside scope, and the result's scope fact is unknown or not yet recorded
- **THEN** the path does not make the finding out of contract

#### Scenario: Advisory findings are recorded only
- **WHEN** a reviewer submits a P2 with a clause and evidence
- **THEN** it is classified advisory and never fails a round

### Requirement: The verdict is derived from the ledger
A structured submission's verdict SHALL be `fail` exactly when the task has a blocking finding, read from the ledger at read time: a P0 or P1 in state `accepted`, `still-open`, or `reopened`. A submitted verdict that differs from the derived one SHALL be refused naming both, with nothing written. The tool's reply SHALL list each finding's id, class, and reason.

#### Scenario: Only accepted findings fail
- **WHEN** a reviewer submits one unsupported P0, one out-of-contract P1, and one advisory P2, and no finding of the task is blocking
- **THEN** the derived verdict is pass

#### Scenario: A contradicting verdict is refused
- **WHEN** a reviewer submits `verdict: pass` together with an accepted P1
- **THEN** the submission is refused naming the submitted pass and the derived fail, and nothing is written

#### Scenario: A rejected dispute clears fixes requested
- **WHEN** a manual task's only blocking finding F1 made its result read fixes requested, and the creator rejects the dispute of F1
- **THEN** every reader of the task, including its stage and attention items, shows the result's verdict as pass, and the stored submission is unchanged

#### Scenario: An empty structured submission passes
- **WHEN** a reviewer submits an empty findings list on a task with no open findings
- **THEN** the derived verdict is pass

### Requirement: A verify round disposes of every open finding
A structured submission on a newer result SHALL give a disposition for each finding blocking at that time: `resolved`, `still-open`, or `regressed`, the latter two with evidence. A submission that omits one SHALL be refused naming the missing ids. `regressed` SHALL record `still-open`, marked regressed. A disputed finding SHALL need no disposition.

#### Scenario: A fixed finding resolves
- **WHEN** F2 was accepted on result R1, and the review of R2 disposes F2 as resolved with no other finding
- **THEN** F2 reads resolved at R2 and the derived verdict is pass

#### Scenario: A missing disposition is refused
- **WHEN** F2 and F3 are blocking and the review of the next result disposes only F2
- **THEN** the submission is refused naming F3, and nothing is written

#### Scenario: Still open keeps the round failing
- **WHEN** the review of R2 disposes F2 as still-open with evidence
- **THEN** F2 reads still-open at R2 and the derived verdict is fail

### Requirement: A re-raised finding reopens
A new finding citing the same clause, at the same locus, as a resolved finding SHALL take that finding's id and record `reopened`. The locus SHALL be the repository path of the first `file:line` in the evidence, or no path when there is none. Among several matches the most recently resolved SHALL win, then the lowest id. A new finding duplicating a blocking finding SHALL be refused naming that id.

#### Scenario: Same clause, same file
- **WHEN** F2 citing A1 with evidence at `src/a.ts:10` was resolved, and a later review raises a P1 citing A1 with evidence at `src/a.ts:40`
- **THEN** the new finding is recorded as F2, reopened

#### Scenario: Same clause, another file
- **WHEN** F2 citing A1 at `src/a.ts:10` was resolved, and a later finding cites A1 at `src/b.ts:5`
- **THEN** it gets a new id and is gated as a new finding

#### Scenario: A duplicate of an open finding
- **WHEN** F2 citing A1 at `src/a.ts:10` is blocking, and the next review raises a new finding citing A1 at `src/a.ts:12`
- **THEN** the submission is refused, naming F2 and asking for its disposition instead

### Requirement: The developer disputes findings with counter-evidence
A member that submitted a result on the task SHALL dispute blocking findings with `task_dispute_findings`, giving counter-evidence for each, at most 10 per call. A disputed finding SHALL read `disputed` until decided. A finding SHALL be disputed at most once per state it entered; other findings, a holder replaced by a Restart, and other callers SHALL be refused, with nothing written.

#### Scenario: The developer disputes an accepted finding
- **WHEN** the developer of a result disputes F3 with a test run showing the claimed behavior is correct
- **THEN** F3 reads disputed, and its counter-evidence is recorded beside the finding

#### Scenario: A second dispute of the same finding
- **WHEN** F3 was disputed and upheld, and the developer disputes F3 again before any later review
- **THEN** the dispute is refused naming F3, and nothing is written

#### Scenario: A reviewer cannot dispute
- **WHEN** a session that submitted no result on the task disputes F3
- **THEN** the dispute is refused and F3 stays accepted

### Requirement: A dispute's decision upholds or rejects the finding
Upholding SHALL return the finding to its state before the dispute; rejecting SHALL record `rejected`, which never blocks. On a plan task the decision SHALL come from the dispute's decision card. On any other task the task's owner or the human SHALL decide with `task_decide_dispute`, with a rationale, and the dispute's mail SHALL go to the owner. Each decision SHALL be journaled.

#### Scenario: The creator rejects a dispute
- **WHEN** the creator of a manual task, still its owner, rejects the dispute of F3, with a rationale
- **THEN** F3 reads rejected, and the journal names the creator, F3, and the rationale

#### Scenario: Only the creator decides a manual dispute
- **WHEN** a session that is not the creator decides the dispute of F3 on a manual task its creator still owns
- **THEN** the decision is refused and F3 stays disputed

#### Scenario: A handed-over task's disputes go to the new owner
- **WHEN** the creator of a manual task handed it to another session with `task_transfer_owner`, and the developer then disputes F3
- **THEN** the dispute mail goes to the new owner, the new owner's decision is recorded, and a decision by the creator is refused

### Requirement: Each task has a findings ledger
Kawai SHALL keep, per task, one ledger row per finding id: its level, clause, current state, and every transition, each with its result, submission or decision, contract identity, and time. `task_get`, the Team page's task detail, and the result card SHALL show it. Every reader SHALL derive the ledger the same way from the stored submissions and events.

#### Scenario: The ledger shows a finding's history
- **WHEN** F2 was accepted on R1, disputed, upheld, and resolved on R2
- **THEN** `task_get` lists F2 with the four transitions in order, each naming its result or decision

#### Scenario: Text-only findings stay readable
- **WHEN** a task has findings submitted as text before this change
- **THEN** they read as unstructured findings with their verdict, and the ledger has no rows for them

### Requirement: One review per result counts, and it becomes final
The ledger SHALL count, per result, the newest structured submission that counts: on a plan change's task, one answering the review handoff as its claimant; on any other task, any structured one. It SHALL become final once one of its findings is disputed, a newer result's review counts, or its round is decided; a later counting submission on that result SHALL then be refused. Other submissions SHALL be shown as not counted.

#### Scenario: A corrected review replaces the first
- **WHEN** a reviewer of a manual task submits findings on R1 and, before anything else happens, submits corrected findings on R1
- **THEN** the ledger counts the corrected submission and shows the first as replaced

#### Scenario: Findings on a result become final
- **WHEN** a finding from the counted review of R1 has been disputed, and the reviewer submits new findings on R1
- **THEN** the submission is refused naming the dispute, and the ledger keeps the earlier review

#### Scenario: A non-claimant's findings do not count
- **WHEN** a member that is not the review handoff's claimant submits an accepted P1 on a plan change's result
- **THEN** it is shown as not counted, and the ledger and the round ignore it

### Requirement: A new contract re-maps open findings
When a task revision with a different contract identity is published, each blocking or disputed finding SHALL move to the clause with the same id in the new contract, recording `remapped` with the new identity, and otherwise record `superseded`, which never blocks. A citation of a revision identity SHALL re-map only to a revision without a contract. Each transition SHALL be journaled.

#### Scenario: The clause survives
- **WHEN** F2 cites `r2#aaaaaaaaaaaa › A1` and revision 3's contract still has A1
- **THEN** F2 cites `r3#<hash12> › A1`, keeps its state, and records the re-map

#### Scenario: The clause is gone
- **WHEN** F4 cites A5 and revision 3's contract has no A5
- **THEN** F4 reads superseded and no longer blocks
