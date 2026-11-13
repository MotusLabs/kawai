## MODIFIED Requirements

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
