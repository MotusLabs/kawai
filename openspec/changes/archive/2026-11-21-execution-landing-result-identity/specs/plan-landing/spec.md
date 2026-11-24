## ADDED Requirements

### Requirement: Kawai accepts the authorizing round's own result
After a landing fact, direct or integration-branch, Kawai SHALL accept the result named by the round that authorized the landing step, identified by that round, never by searching for the landed commit. The round SHALL belong to the same execution and change and name the landed head; otherwise Kawai SHALL accept nothing and leave the task open. A task already done or cancelled SHALL stay as it is. A replayed follow-on SHALL accept the same result. Past acceptances SHALL NOT be rewritten.

#### Scenario: Two results share the landed commit
- **WHEN** a change's earlier round named result R1 on commit C, a later round named result R2 on the same commit C, and the later round's pass lands C
- **THEN** the task is done with R2 accepted by Kawai, and R1 stays unaccepted

#### Scenario: Integration-branch landing names the same result
- **WHEN** an integration-branch change whose rounds share commit C lands through the later round's fast-forward
- **THEN** the task is done with that round's result accepted, and the earlier same-commit result stays unaccepted

#### Scenario: A carried round lands
- **WHEN** a clean base merge carried a passed round onto a new head, and the carried round's merge lands that head
- **THEN** Kawai accepts the result the carried round names

#### Scenario: A result submitted while the merge runs
- **WHEN** a new result is submitted after the merge started and the merge then completes
- **THEN** Kawai accepts the authorizing round's result, and the new result stays unaccepted

#### Scenario: The authorizing round cannot be confirmed
- **WHEN** the landing step names no round, a round of another execution or change, or a round on a commit other than the landed head
- **THEN** the change is landed, Kawai accepts no result, the task stays open for the human, and the refusal is logged

#### Scenario: The task was closed by hand during the merge
- **WHEN** the human accepted any result or cancelled the task while the merge ran
- **THEN** the change lands and the task keeps the human's close, with no acceptance by Kawai

#### Scenario: The authorizing result is pinned to an older revision
- **WHEN** the authorizing round's result was submitted under an older task revision than the task's current one
- **THEN** the change lands, Kawai's acceptance is refused for want of a stated reason, and the task stays open

#### Scenario: The follow-on is replayed
- **WHEN** the landing follow-on runs again for the same landing step after a restart or a stop
- **THEN** no other result is accepted and no second acceptance is written
