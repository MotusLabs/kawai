# Spec Delta

## Purpose

Routes work aimed at a worktree to agents running in that worktree and, within configured limits, starts a group member there when none is free.

## ADDED Requirements

### Requirement: Worktree task mail goes to members in that worktree
A group message whose task has a target worktree SHALL be delivered only to an idle group member whose project directory is that worktree. Members in other directories of the same repository SHALL NOT receive it.

#### Scenario: Matching member
- **WHEN** a message for `devs` references a task targeting worktree `feat-x` and an idle `devs` member runs in `feat-x`
- **THEN** that member receives it

#### Scenario: Member elsewhere is skipped
- **WHEN** the only idle `devs` member runs in the main checkout and the task targets `feat-x`
- **THEN** that member does not receive the message

### Requirement: A member is spawned when none is available
When a worktree task message has no idle member in its worktree and spawning is allowed, the system SHALL create a new chat session of that group in the worktree and deliver the message as its first turn. The new session SHALL use the group's `profile` and `approval` frontmatter, defaulting to the default profile and manual approval, and SHALL be associated with the task.

#### Scenario: Spawn for an unstaffed worktree
- **WHEN** a team lead sends a task message to `devs` for worktree `feat-x` and no `devs` member runs there
- **THEN** a new `devs` chat session is created in `feat-x` and receives the message as its first turn

#### Scenario: Group settings applied
- **WHEN** the `devs` group sets `profile: glm` and `approval: auto`
- **THEN** the spawned session uses the `glm` profile and the auto approval policy

### Requirement: Spawning is bounded
The system SHALL NOT spawn when the group already has `max` live members (default 1), when the team already has its maximum live spawned sessions (default 5, set in `~/.kawai/teams.json`), or when the worktree already has a live spawned member of any group that is not archived. A message that cannot spawn SHALL wait and be re-evaluated when a member becomes idle or a slot frees.

#### Scenario: Group cap
- **WHEN** `devs` has `max: 2` and two live members, both busy in other worktrees
- **THEN** no session is spawned and the message waits

#### Scenario: One spawned writer per worktree
- **WHEN** a spawned `devs` member already runs in `feat-x` and is busy
- **THEN** a second task message for `feat-x` waits for it instead of spawning another

### Requirement: Spawned sessions are visible
A spawned session SHALL appear in the navigator under its worktree, marked as spawned with its task. While it awaits an approval or question from the human, the navigator SHALL flag it as needing attention and the UI SHALL notify the user.

#### Scenario: Spawned session waits for approval
- **WHEN** a spawned session with manual approval requests a tool approval
- **THEN** its navigator row is flagged as needing attention and a notification is shown

### Requirement: No worktree is created implicitly
The system SHALL NOT create a git worktree to satisfy a message. A task whose target worktree no longer exists SHALL cause its waiting messages to be dead-lettered with that reason.

#### Scenario: Worktree removed
- **WHEN** a task's target worktree is removed while messages for it wait
- **THEN** those messages are dead-lettered stating the worktree is missing
