# review-convergence Specification

## Purpose
Defines how Kawai measures whether review rounds converge, using the findings
ledger, and what happens when they do not: the convergence signals and their
window, the diagnosis episode that replaces a fix round, its card's
outcomes, and the notice for manual tasks.

## Requirements

### Requirement: Signals read the counted reviews of the current window
Kawai SHALL compute the signals over a task's counted reviews, in ledger order, judging each from the ledger right after it. The window SHALL hold only the reviews under the current contract identity's hash that came after the newest earlier review leaving no blocking finding open, and after the review of the newest closed diagnosis (for a task no execution owns, of its newest notice). The open blocking count SHALL be the number of P0/P1 findings in a blocking state.

#### Scenario: A new contract restarts the window
- **WHEN** reviews R1 and R2 ran under contract hash H1, the owner publishes a revision with a new contract hash H2, and review R3 runs under H2
- **THEN** the window holds only R3, and no signal that needs two or three reviews can fire

#### Scenario: A closed diagnosis restarts the window
- **WHEN** a diagnosis opened on review R4 was decided with Fix round, and review R5 follows
- **THEN** the window holds only R5

#### Scenario: A passing review restarts the window
- **WHEN** review R2 left no blocking finding open, and review R3 raises a new P1 finding
- **THEN** the window holds only R3, and S3 does not fire

#### Scenario: A rewording keeps the window
- **WHEN** the owner publishes a revision whose identity hash is unchanged between R2 and R3
- **THEN** the window still holds R2 and R3

### Requirement: S1 fires when a finding is reopened a second time
The signal S1 (oscillation) SHALL fire when the newest review of the window reopens a finding that had already been reopened at least once before. It SHALL name that finding.

#### Scenario: A second reopen fires S1
- **WHEN** F2 was resolved, reopened by review R2, resolved again by R3, and reopened by R4
- **THEN** S1 fires on R4 naming F2

#### Scenario: A first reopen does not
- **WHEN** F2 was resolved by R2 and reopened by R3 for the first time
- **THEN** S1 does not fire

### Requirement: S2 fires when a fix keeps moving the defect within a clause
The signal S2 (moving clause) SHALL fire when, in each of the last two reviews of the window, a finding citing contract clause C was given `resolved` and a different finding citing the same clause C was raised and is blocking. It SHALL name C and those findings. Findings that cite a whole revision without a contract SHALL never count toward S2.

#### Scenario: Two reviews move the defect on one clause
- **WHEN** review R2 resolves F1 on A2 and raises F4 on A2 at another locus, and review R3 resolves F4 and raises F5 on A2
- **THEN** S2 fires on R3 naming A2, F1, F4, and F5

#### Scenario: Different clauses do not fire
- **WHEN** review R2 resolves F1 on A2 and raises F4 on A2, and review R3 resolves F4 and raises F5 on A3
- **THEN** S2 does not fire

#### Scenario: Revision citations never fire
- **WHEN** a task without a contract has two reviews that each resolve one finding citing the revision and raise another
- **THEN** S2 does not fire

### Requirement: S3 fires when new defects keep pace with fixes
The signal S3 (churn) SHALL fire when the newest review of the window raised a blocking finding (new, or reopened) and, over the last two reviews together, the blocking findings raised are at least as many as the findings given `resolved`. It SHALL name the raised findings.

#### Scenario: Churn fires
- **WHEN** review R2 resolves F1 and F2 and raises F3, and review R3 resolves F3 and raises F4 and F5
- **THEN** S3 fires on R3: three raised, three resolved

#### Scenario: A finding left open does not fire
- **WHEN** review R1 raises F1, and review R2 gives F1 `still-open` and raises nothing
- **THEN** S3 does not fire on R2

#### Scenario: Converging work does not fire
- **WHEN** review R2 resolves F1 and F2 and raises F3, and review R3 resolves F3 and raises nothing
- **THEN** S3 does not fire

### Requirement: S4 fires when the open count stops falling
The signal S4 (stagnation) SHALL fire when the window holds at least three reviews and the open blocking count after each of the last three reviews is not lower than after the review before it, and is above zero after the newest. It SHALL name the three counts.

#### Scenario: A flat count fires
- **WHEN** the open blocking counts after reviews R1, R2, and R3 are 3, 3, and 3
- **THEN** S4 fires on R3 naming 3, 3, 3

#### Scenario: A falling count does not fire
- **WHEN** the counts after R1, R2, and R3 are 5, 3, and 3
- **THEN** S4 does not fire

### Requirement: S5 fires on repeated out-of-contract findings
The signal S5 (scope pressure) SHALL fire when each of the last two reviews of the window raised at least one finding the gate classed out of contract. It SHALL name those findings.

#### Scenario: Two reviews push outside the contract
- **WHEN** review R2 raises F3 out of contract and review R3 raises F6 out of contract
- **THEN** S5 fires on R3 naming F3 and F6

#### Scenario: One review does not fire
- **WHEN** only review R3 raises an out-of-contract finding
- **THEN** S5 does not fire

### Requirement: A signal or the backstop opens a diagnosis instead of a fix round
When a round of a plan change fails, Kawai SHALL open a diagnosis instead of dispatching its fix if a signal fires on that round's review, or the failed fix rounds since the change's last pass or closed diagnosis reach the backstop. A round that failed without a new counted review SHALL open one only at the backstop. A failed round SHALL open at most one diagnosis, after a restart as well.

#### Scenario: A signal replaces the fix round
- **WHEN** a change's round fails and S4 fires on its review
- **THEN** no fix handoff is dispatched, the change waits on a diagnosis naming S4, and the diagnosis card is raised

#### Scenario: A CI-only failure does not re-fire a signal
- **WHEN** a diagnosis on review R3 was decided with Fix round, and the next round fails its CI before any review
- **THEN** no diagnosis opens, and the fix handoff is dispatched

#### Scenario: One diagnosis across a restart
- **WHEN** Kawai restarts after a failed round opened its diagnosis
- **THEN** the change still waits on that one diagnosis, and no second card is raised

### Requirement: A signal never decides a finding
A convergence signal or an open diagnosis SHALL NOT change any finding's state, the round's outcome, or the derived verdict. Only a recorded decision on the diagnosis card SHALL apply an outcome.

#### Scenario: Signals leave the ledger alone
- **WHEN** S3 fires on a round that failed on F3 and F4
- **THEN** F3 and F4 still read accepted, and the round still reads failed

### Requirement: Fix round sends the fix with the decision's rationale
When the diagnosis card is decided with `Fix round`, Kawai SHALL dispatch the failed round's fix as it would without a diagnosis, adding the decision's rationale to the handoff, and SHALL close the diagnosis. The failed fix rounds counted toward the backstop SHALL start again from zero.

#### Scenario: The Lead keeps going
- **WHEN** the Lead decides a diagnosis with `Fix round` and the rationale "the count fell from 5 to 3; continue"
- **THEN** the implementing group receives the fix handoff listing the blocking findings and that rationale, and the backstop count reads zero

### Requirement: Reject rejects the named findings
When the diagnosis card is decided with its `Reject` option, every finding that option names SHALL read rejected by that decision. If no finding then blocks and none is disputed, Kawai SHALL gate the failed round's result again as a passing round, keeping its CI and review. Otherwise Kawai SHALL dispatch a fix for the findings that still block or await a dispute decision. Either way the diagnosis SHALL close.

#### Scenario: Rejecting every blocker passes the result
- **WHEN** a round failed on F3 and F4, and the diagnosis is decided with `Reject F3, F4`
- **THEN** F3 and F4 read rejected, a new round for the same result passes on its kept CI and review, and no fix handoff is dispatched

#### Scenario: Rejecting some blockers fixes the rest
- **WHEN** a round failed on F3, F4, and F7, and the decision is `Reject F3, F4`
- **THEN** F3 and F4 read rejected, and a fix handoff listing F7 alone is dispatched

### Requirement: Amend the contract waits for the owner's revision
When the diagnosis card is decided with `Amend the contract`, the change SHALL keep waiting, and the owner SHALL see an attention item to publish a new revision of the change's task, carrying the decision's rationale. A new task revision published while the diagnosis is open SHALL close the diagnosis and return the change for re-evaluation as for any new task revision, with the backstop count at zero.

#### Scenario: The owner publishes the amended contract
- **WHEN** the Lead decides `Amend the contract` with the proposed clause, and the owner publishes revision 4 of the task with that clause
- **THEN** the diagnosis closes, and a fix attempt naming revision 4 is dispatched

#### Scenario: The Lead cannot publish it
- **WHEN** the Lead decides `Amend the contract`
- **THEN** no task revision is published until the owner publishes one, and the change shows it waits on the contract revision

### Requirement: Reassign sends the fix to another group
When the diagnosis card is decided with `Reassign to <group>`, Kawai SHALL dispatch the failed round's fix to that group, and later fix and update attempts of the change in this execution SHALL go to it too. Kawai SHALL release the previous implementer once it is ready, as after a review. The diagnosis SHALL close and the backstop count SHALL read zero.

#### Scenario: A stuck change goes to another group
- **WHEN** the plan names `middle-devs` for `api` and `senior-devs` for another change, and the diagnosis of `api` is decided with `Reassign to senior-devs`
- **THEN** the fix handoff goes to `senior-devs`, and the next fix attempt of `api` also goes to `senior-devs`

### Requirement: Escalate stops the change for the owner
When the diagnosis card is decided with `Escalate`, the change SHALL stop as `diagnosis-escalated`, naming the signals and the decision's rationale, and the diagnosis SHALL close.

#### Scenario: The Lead escalates
- **WHEN** the Lead decides a diagnosis with `Escalate`
- **THEN** the change reads stopped as `diagnosis-escalated` with the signals, and the owner sees **Retry or stop execution**

### Requirement: The first decision of an open diagnosis applies
A diagnosis SHALL apply the card's decision while the diagnosis is open, once. A diagnosis waiting for an amended contract SHALL stay open, so an owner override then applies its new choice. A decision or override after the diagnosis closed SHALL be journaled and SHALL NOT dispatch, stop, or reject anything.

#### Scenario: An override while waiting for the amendment
- **WHEN** the Lead decided `Amend the contract`, and the owner overrides the card with `Fix round` before publishing a revision
- **THEN** the fix handoff is dispatched and the diagnosis closes

#### Scenario: An override after a fix round went out
- **WHEN** the Lead decided `Fix round`, the fix went out, and the owner overrides the card with `Escalate`
- **THEN** the override is journaled and creates its forward-fix task as for any card, and the change is not stopped

### Requirement: Manual tasks get a convergence notice
When a counted review of a task no execution owns makes a signal fire, Kawai SHALL journal the signals on the task and send one message to the task's creator when the creator is a session. Nothing SHALL wait, and the same review SHALL never send a second notice.

#### Scenario: A manual task churns
- **WHEN** the Lead created a task by hand and S3 fires on its third review
- **THEN** the task's journal names S3 and its findings, and the Lead receives one message from Kawai about it
