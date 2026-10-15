# Spec Delta

## ADDED Requirements

### Requirement: Results for execution tasks are checked at submission
For a task of a change a running execution owns, `task_submit_result` SHALL refuse, writing nothing and naming the fix, in these cases:
- a result without a commit;
- a commit not on the change's branch in its worktree;
- a commit that does not contain the branch's head on `origin`, with guidance to merge `origin/<branch>` first;
- any result while the change is landing.

A refused result SHALL cost no round.

#### Scenario: A diff-only result
- **WHEN** a dev submits a result with only a diff for an execution task
- **THEN** the result is refused naming the missing commit, and no result or round exists

#### Scenario: A commit behind the published head
- **WHEN** the branch on `origin` has a base-merge commit that the submitted commit does not contain
- **THEN** the result is refused with guidance to merge `origin/<branch>` first, and no round is counted

### Requirement: Kawai owns the handoffs of a running change
While a running execution owns a change, `task_handoff`, the human's handoffs, and **Release worktree and hand off** on its task SHALL be refused, naming the execution and pointing to `task_submit_findings`. Kawai SHALL request reviews and return fixes itself. Findings SHALL still be accepted and recorded.

#### Scenario: A reviewer returns fixes by tool
- **WHEN** a reviewer calls `task_handoff` with kind `fix` on an execution task
- **THEN** the call is refused with the guidance and nothing is dispatched, while its `fail` verdict through `task_submit_findings` returns the change

#### Scenario: The human requests review by hand
- **WHEN** the human chooses **Request review** on the task of a change a running execution owns
- **THEN** the handoff is refused naming the execution, and nothing is dispatched
