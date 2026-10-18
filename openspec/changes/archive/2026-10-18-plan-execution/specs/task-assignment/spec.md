# Spec Delta

## ADDED Requirements

### Requirement: Kawai dispatches plan-execution assignments
A plan execution SHALL dispatch its instructions and handoffs through task assignment with Kawai as the dispatcher. The assignment row and its mail SHALL commit in one transaction, under a request key derived from the execution, the change, and the step. A replayed step SHALL return the prior assignment and never dispatch twice.

#### Scenario: Kawai's assignment names its dispatcher
- **WHEN** Kawai dispatches a change's implement attempt
- **THEN** the task's assignment names Kawai as dispatcher and the implementing group as target, and its state follows the instruction mail like any assignment

#### Scenario: A replayed step dispatches once
- **WHEN** the executor runs the same dispatch step again after a restart
- **THEN** one assignment and one instruction exist for that step

### Requirement: Only Kawai dispatches a running change's task
While a running execution owns a change, a dispatch onto its task by the human or an agent, including reassignment, SHALL be refused naming the execution, with guidance to close the task or stop the execution, and SHALL write nothing. Kawai's own next stage SHALL supersede its earlier one as handoffs do.

#### Scenario: Human reassignment refused
- **WHEN** the human chooses **Assign / send task** on the task of a change a running execution owns
- **THEN** the dispatch is refused naming the execution, with the guidance, and nothing is written

#### Scenario: Kawai's next stage supersedes the review
- **WHEN** Kawai dispatches a fix handoff after a failed review
- **THEN** the review assignment is superseded, and its instruction is cancelled only while still queued or awaiting a request
