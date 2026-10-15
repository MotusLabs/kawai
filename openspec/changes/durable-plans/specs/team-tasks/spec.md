# Spec Delta

## ADDED Requirements

### Requirement: Tasks may link to a plan change
A task SHALL optionally name, at creation, a plan of its team and one change of that plan's current approved revision; both or neither SHALL be given. The plan SHALL be open and have an approved revision, and any other reference SHALL be refused naming it. The link SHALL be immutable after creation and SHALL survive later plan revisions.

#### Scenario: Linked at creation
- **WHEN** the lead creates a task naming plan P and its change `api`
- **THEN** the task records the link, and P's detail lists the task under `api`

#### Scenario: Plan without an approved revision refused
- **WHEN** a task names a plan that has only revisions in review
- **THEN** creation is refused naming the plan, and no task is created

#### Scenario: Unknown change refused
- **WHEN** a task names change `cli` of a plan whose approved revision has no change `cli`
- **THEN** creation is refused naming `cli`

#### Scenario: Another team's plan refused
- **WHEN** a task names a plan of another team
- **THEN** creation is refused as if the plan did not exist

### Requirement: Delivered mail for a linked task names its plan change
When a message referencing a task linked to a plan change is delivered, the task context SHALL name the plan's title and id, its current approved revision at delivery, and the change. Tasks without a link SHALL keep the existing context shape.

#### Scenario: Plan line on delivery
- **WHEN** an agent receives a message referencing a task linked to change `api` of plan P at approved revision 2
- **THEN** the delivered context names P, revision 2, and `api`

#### Scenario: Unlinked task unchanged
- **WHEN** an agent receives a message referencing a task without a plan link
- **THEN** the delivered context has no plan fields
