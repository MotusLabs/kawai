# Spec Delta

## ADDED Requirements

### Requirement: The current context names its repository
The system SHALL derive one context name. While a Team page is shown it SHALL name the team's repository. Otherwise it SHALL name the repository owning the working directory of the selected session (a chat or terminal, live or archived, or a hibernating session): the repository of the deepest discovered worktree containing that path, matched by whole path segments. A remote session, or an unowned path, SHALL use the path's final non-empty component. No selection SHALL mean no context name.

#### Scenario: A linked worktree names its repository
- **GIVEN** the discovered repository `kawai` has the main worktree `/home/coder/kawai` and the linked worktree `/home/coder/kawai/.worktrees/adopt-tool-call-metrics`
- **WHEN** the user selects a chat whose working directory is `/home/coder/kawai/.worktrees/adopt-tool-call-metrics/src`
- **THEN** the context name is `kawai`

#### Scenario: A sibling path is not inside a worktree by prefix
- **GIVEN** the discovered repository `kawai` has the worktree `/home/coder/kawai` and no worktree at `/home/coder/kawai-notes`
- **WHEN** the user selects a chat whose working directory is `/home/coder/kawai-notes`
- **THEN** the context name is `kawai-notes`

#### Scenario: Archived chats name their repository too
- **WHEN** the user selects an archived chat whose working directory is inside a worktree of the discovered repository `kawai`
- **THEN** the context name is `kawai`

#### Scenario: Terminals and hibernating sessions name their repository
- **WHEN** the user selects a terminal session, or a hibernating session, whose working directory is `/home/coder/kawai/.worktrees/adopt-tool-call-metrics`, a worktree of the discovered repository `kawai`
- **THEN** the context name is `kawai`

#### Scenario: A remote session uses its directory name
- **GIVEN** the discovered repository `kawai` has the local worktree `/home/coder/kawai/.worktrees/adopt-tool-call-metrics`
- **WHEN** the user selects a remote session whose working directory is `/home/coder/kawai/.worktrees/adopt-tool-call-metrics`
- **THEN** the context name is `adopt-tool-call-metrics`, not `kawai`

#### Scenario: The repository name replaces the directory name once discovered
- **GIVEN** no workspace snapshot has arrived yet
- **WHEN** the user selects a chat whose working directory is `/home/coder/kawai/.worktrees/adopt-tool-call-metrics`
- **THEN** the context name is `adopt-tool-call-metrics`
- **AND** it becomes `kawai` when a snapshot listing that worktree under repository `kawai` arrives

#### Scenario: A Team page names the team's repository
- **GIVEN** a chat of repository `kawai` is selected, and the discovered repository named `Manga Studio 日本` has its main checkout at `/projects/manga`
- **WHEN** the user opens the Team page of that repository
- **THEN** the context name is `Manga Studio 日本`, not the checkout's directory name `manga`
- **AND** returning to Sessions makes it `kawai` again

#### Scenario: A plain-directory Team page uses its directory name
- **WHEN** the user opens the Team page of `/projects/another-project`, which no discovered repository owns
- **THEN** the context name is `another-project`

#### Scenario: Nothing selected has no context name
- **WHEN** no session is selected and no Team page is shown
- **THEN** there is no context name

### Requirement: The navigator heading shows the context name
Wherever the navigator heading is shown, it SHALL show the context name. With no context name it SHALL show the server workspace name the browser title uses, and with neither it SHALL show `KAWAI`. Names SHALL keep their spelling, case, spaces, and Unicode characters. A long name SHALL truncate on one line without widening the navigator. The heading's tooltip SHALL stay `Kawai v<version>` when the server version is known.

#### Scenario: The heading follows the selected chat
- **WHEN** the user selects a chat whose context name is `kawai`, then a chat whose context name is `Manga Studio 日本`
- **THEN** the heading reads `kawai`, then `Manga Studio 日本`

#### Scenario: The heading falls back to the server workspace
- **WHEN** no session is selected and the server reports default project directory `/projects/anime-studio`
- **THEN** the heading reads `anime-studio`

#### Scenario: The heading has a last-resort fallback
- **WHEN** no session is selected and neither server directory has a usable name, or server information has not arrived
- **THEN** the heading reads `KAWAI`

#### Scenario: Leaving a Team page shows the chat's heading
- **GIVEN** a chat whose context name is `kawai` is selected and a Team page is shown
- **WHEN** the user returns to Sessions
- **THEN** the navigator heading is shown and reads `kawai`

#### Scenario: A long name keeps the navigator width
- **WHEN** the context name is longer than the heading's space
- **THEN** the heading shows it truncated on one line and the navigator keeps its width
- **AND** hovering the heading shows `Kawai v<version>`
