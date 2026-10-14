## MODIFIED Requirements

### Requirement: Only the creator or the human amends direction
The task's direction and acceptance criteria SHALL be changeable only by the task's creator or the human. A change SHALL become a new numbered revision only when published; the human's saved drafts are not revisions. Earlier revisions SHALL remain viewable. Other agents' attempts SHALL be refused with an error suggesting a journal note or a message to the creator.

#### Scenario: Creator amends
- **WHEN** the creating team lead amends the direction
- **THEN** the task shows the new direction as revision 2 and revision 1 remains viewable

#### Scenario: Contributor cannot amend
- **WHEN** a dev agent tries to amend a task it did not create
- **THEN** the tool returns an error and the direction is unchanged

#### Scenario: Human draft is not a revision
- **WHEN** the human saves a draft of a new direction without publishing it
- **THEN** the task still shows revision 1 as its direction

### Requirement: Tasks are inspectable in the UI
The UI SHALL list a team's tasks with title, status, creator, and participants, and SHALL show a task's direction with revision history and rationale, journal, subtasks, and messages. The human SHALL be able to change status, and to change direction from the task detail through **Save draft**, **Publish revision**, and **Publish and notify**. A chat session working on a task SHALL show the task in its header.

#### Scenario: Task detail
- **WHEN** the user opens a task
- **THEN** its direction, revisions, journal, subtasks, and messages are shown

#### Scenario: Three direction actions
- **WHEN** the user edits a task's direction in the detail
- **THEN** **Save draft**, **Publish revision**, and **Publish and notify** are offered as separate actions
