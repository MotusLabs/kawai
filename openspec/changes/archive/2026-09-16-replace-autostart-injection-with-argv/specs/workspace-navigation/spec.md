## MODIFIED Requirements

### Requirement: Start sessions in worktrees
The system SHALL allow a user to start a managed tmux session in any discovered local worktree from both the section header's new-session action and the new-session flow.

#### Scenario: Quick-create from a section
- **WHEN** the user invokes the new-session action on a section whose worktree already exists
- **THEN** the session form uses that worktree root as its initial project path, offers the first-prompt selector, and retains command preset and optional name controls

#### Scenario: Select worktree in new-session flow
- **WHEN** the user selects a discovered worktree in the new-session flow and submits valid session options
- **THEN** the system creates the tmux window with that worktree as its working directory

#### Scenario: Worktree disappears before session creation
- **WHEN** the selected worktree directory no longer exists at submission time
- **THEN** the system rejects creation with an actionable error and refreshes workspace metadata

### Requirement: Auto-start the change's apply command
The system SHALL offer, in the session form opened from a change section, a selector for the change's apply command — `/opsx:apply <change>` for Claude, the equivalent for Codex, or no prompt at all — and SHALL start the session with the selected command as the agent's first prompt by passing it to the agent as a launch argument. The selector SHALL be offered for every command and every host, and SHALL show the literal prompt each option would send. Nothing SHALL be sent when no agent is selected.

The selector's initial value SHALL be the selected command preset's declared agent type when it declares one, otherwise Claude or Codex when the command's agent token begins with `claude` or `codex`, otherwise no prompt. It SHALL follow changes to the command until the user selects a value explicitly, after which the user's selection SHALL persist for the remainder of the form.

The system SHALL NOT send the apply command as terminal input, and SHALL NOT replay it when a session started this way is later resumed.

#### Scenario: Auto-start enabled
- **WHEN** the user submits the session form with Claude or Codex selected in the first-prompt selector
- **THEN** the system creates the session with the mapped apply command passed as the agent's launch argument, and the agent begins that prompt once it is ready

#### Scenario: Client reloads before the agent is ready
- **WHEN** the client reloads between session creation and the agent becoming ready
- **THEN** the first prompt is unaffected, because it is carried in the session's launch command rather than held as pending client or server state

#### Scenario: Auto-start disabled or agent unrecognized
- **WHEN** the user submits the session form with no agent selected in the first-prompt selector
- **THEN** the session is created with an unmodified command and no prompt is delivered to it

#### Scenario: Agent starts on a trust or sign-in gate
- **WHEN** the created session's agent opens on a directory-trust or sign-in prompt before reaching its input
- **THEN** the pending first prompt is neither consumed nor answered by the gate, and the agent begins it after the user clears the gate

#### Scenario: Unrecognized command still offers the selector
- **WHEN** the form's command matches no preset declaration and its agent token begins with neither `claude` nor `codex`
- **THEN** the selector is still offered, defaults to sending no prompt, and remains selectable by the user

#### Scenario: Remote host
- **WHEN** the user submits the session form for a remote host with an agent selected
- **THEN** the remote session is created with the mapped apply command passed as the agent's launch argument

#### Scenario: Session resumed after auto-start
- **WHEN** a session created with a first prompt is later resumed
- **THEN** the resumed session carries the original launch flags without the apply command, and the apply command is not delivered again
