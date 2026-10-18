# Spec Delta

## Purpose

Keeps Kawai's recovery behaviour written down and tested: one maintained matrix maps each fault to its mechanism and test. It also holds the late-writer invariants. Every exclusive slot holder has a liveness check, and results keep their revision pins, so a late or stale writer never wins without leases or fencing.

## ADDED Requirements

### Requirement: A maintained recovery matrix maps faults to tests
Kawai SHALL keep `docs/recovery-matrix.md` listing each fault with its mechanism, owning change, contract, and test, or `gap` with the reason. It SHALL cover the durability table of the multi-agent UX doc, R17–R19, and this change's capture, backup, and migration faults. A change adding a recovery mechanism or exclusive slot SHALL add its row in the same change.

#### Scenario: Every row names a test or a gap
- **WHEN** a reviewer reads the matrix
- **THEN** each fault names a test file and test, or is marked `gap` with its reason

#### Scenario: A new mechanism adds its row
- **WHEN** a later change adds a startup reconciliation
- **THEN** the same change adds the matrix row naming its test

### Requirement: An unknown outcome survives restart as unknown
After a restart, every recorded outbound call without an outcome SHALL read outcome unknown, because its agent process no longer lives. Kawai SHALL NOT re-run, re-classify, or settle it, and a resumed session's later calls SHALL be new rows.

#### Scenario: Restart between call and outcome
- **WHEN** the server stops after a send was recorded and before its outcome, then starts again
- **THEN** the call reads outcome unknown, nothing is re-run, and the row is unchanged

#### Scenario: The session resumes
- **WHEN** that session's agent resumes its conversation after the restart and pushes again
- **THEN** the new push is a new row with its own outcome, and the earlier call still reads outcome unknown

### Requirement: Every exclusive slot holder has a liveness check
Any holder kind of the landing slot, of promotions, or of a later exclusive slot SHALL ship with a liveness predicate, clearance of orphan holders at startup and whenever the slot is found taken, and a matrix row naming its test. Kawai SHALL NOT add leases, epochs, or fencing tokens.

#### Scenario: An orphan holder after a crash
- **WHEN** the server restarts with the landing slot held by a change that is no longer landing
- **THEN** the orphan row is cleared and logged, and another change may take the slot

#### Scenario: An orphan promotion holder
- **WHEN** a promotion holds the slot at startup but its promotion is no longer running
- **THEN** the holder is cleared by its own liveness check, and the matrix row names that check's test

### Requirement: Late results stay pinned and never win
A result SHALL keep the task revision it was submitted under. A result from a superseded holder or a stale revision SHALL be recorded as readable history, SHALL read as needing re-evaluation when stale, and SHALL NOT be accepted or landed in place of the current stage's work.

#### Scenario: A superseded agent submits
- **WHEN** an agent whose assignment was superseded submits a result
- **THEN** the result is readable in the task's history and the current assignment is unchanged

#### Scenario: A stale pin
- **WHEN** a result pinned to revision 2 is read after revision 3 is published
- **THEN** it reads as needing re-evaluation, and accepting it requires a stated reason
