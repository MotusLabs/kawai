# Spec Delta

## MODIFIED Requirements

### Requirement: Worktree task mail goes to members in that worktree
A group message whose task has a target worktree SHALL be delivered only to an idle group member whose current worktree — the root of the worktree containing the member's current project directory — is that worktree, unless the receiving group's current file sets `worktreeScoped: false`. A member whose agent has moved into a subdirectory of the worktree SHALL still match. Members whose current worktree is another directory of the same repository SHALL NOT receive it.

#### Scenario: Matching member
- **WHEN** a message for `devs` references a task targeting worktree `feat-x` and an idle `devs` member runs in `feat-x`
- **THEN** that member receives it

#### Scenario: Member in a subdirectory still matches
- **WHEN** a task targets worktree `feat-x` and an idle `devs` member's agent has changed into `feat-x/src`
- **THEN** that member receives the message

#### Scenario: Member elsewhere is skipped
- **WHEN** the only idle `devs` member runs in the main checkout and the task targets `feat-x`
- **THEN** that member does not receive the message

## ADDED Requirements

### Requirement: Groups can opt out of worktree scoping
A group file SHALL accept `worktreeScoped: true|false` (default `true`). Task mail to a group whose current file sets `false` SHALL go to any idle member of the group wherever it runs, and SHALL NOT cause a member to be spawned. Any other value SHALL be reported and the file skipped, as for other invalid settings.

#### Scenario: Dev report reaches the lead in the main checkout
- **WHEN** the `lead` group sets `worktreeScoped: false`, its only member runs in the main checkout, and a dev sends the `lead` group a message referencing a task targeting `feat-x`
- **THEN** the lead receives it

#### Scenario: Killed lead's thread reaches the new lead
- **WHEN** the `lead` group sets `worktreeScoped: false` and a dev replies, with its task, to a message from a lead that was killed
- **THEN** the reply falls back to the `lead` group and the current lead in the main checkout receives it with the thread

#### Scenario: No spawn for an unscoped group
- **WHEN** the `reviewers` group sets `worktreeScoped: false`, has no idle member, and receives task mail targeting `feat-x`
- **THEN** no session is spawned and the message waits for a reviewer to become idle

#### Scenario: Default keeps worktree routing
- **WHEN** the `devs` group file does not set `worktreeScoped`
- **THEN** task mail to `devs` is delivered and staffed per worktree as before
