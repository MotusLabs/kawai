# Spec Delta

## ADDED Requirements

### Requirement: A task revision may carry a contract
Creating a task SHALL accept an optional contract in the implementation-contract grammar, from the human's task form and from `task_create`'s `contract` parameter. A contract that does not parse SHALL refuse the creation with every problem the parser reported, and create nothing. The contract SHALL become part of revision 1.

#### Scenario: Lead creates a task with a contract
- **WHEN** a lead calls `task_create` with a direction and a well-formed contract
- **THEN** the task's revision 1 carries that contract and its identity `r1#<hash>`

#### Scenario: Malformed contract refused
- **WHEN** a lead calls `task_create` with a contract that lacks the Scope heading
- **THEN** the tool returns an error naming the missing heading and its line, and no task is created

#### Scenario: Task without a contract
- **WHEN** the human creates a task without a contract
- **THEN** the task exists, and its revision 1 is labeled as having no contract

### Requirement: Amendments carry the contract forward or replace it
An amendment that omits the contract SHALL carry the previous revision's contract into the new revision unchanged. One that supplies a contract SHALL replace it, after it parses. A revision SHALL NOT drop a contract once a revision of the task carried one.

#### Scenario: Direction-only amendment
- **WHEN** the creator amends revision 2's direction without supplying a contract
- **THEN** revision 3 carries revision 2's contract, with the same hash

#### Scenario: Contract replaced
- **WHEN** the creator amends with a contract that adds invariant I3
- **THEN** revision 3 carries the new contract with a new hash, and revision 2 still shows the old one

#### Scenario: Contract cannot be removed
- **WHEN** the human publishes a draft that clears the contract of a task whose revision 2 carried one
- **THEN** the publication is refused naming the contract, and the draft remains

### Requirement: Task reads show each revision's contract
`task_get`, the Team page's task view, and its revision history SHALL show each revision's contract identity and, for a revision with a contract, its clauses and scope globs, or label it as having no contract.

#### Scenario: Revision history shows contracts
- **WHEN** the human opens the revision history of a task whose revision 1 had no contract and revision 2 has one
- **THEN** revision 1 is labeled as having no contract and revision 2 shows its identity, clauses, and scope

## MODIFIED Requirements

### Requirement: Delivered task messages carry the task context
When a message referencing a task is delivered, the recipient SHALL receive with it the task's title, current direction and acceptance criteria, revision number, contract identity and, when the revision carries a contract, its clauses and scope globs, status, linked change, target worktree, and its most recent journal entries. If the task has a linked OpenSpec change, the context SHALL state that the change's artifacts are the authoritative direction.

#### Scenario: Task header on delivery
- **WHEN** a QA agent receives a message referencing task T
- **THEN** the delivered turn includes T's title, direction, status, and latest journal entries

#### Scenario: Linked change is authoritative
- **WHEN** a message references a task linked to OpenSpec change `add-x`
- **THEN** the delivered context names `add-x` and says its proposal, design, and tasks are the authoritative direction

#### Scenario: Contract in the header
- **WHEN** a reviewer receives a message referencing a task whose revision 3 carries a contract
- **THEN** the delivered context includes the identity `r3#<hash>`, each clause with its id, and the scope globs

#### Scenario: No contract in the header
- **WHEN** a dev receives a message referencing a task whose current revision has no contract
- **THEN** the delivered context includes the revision's text identity and says the task has no contract
