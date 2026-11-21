# Spec Delta

## ADDED Requirements

### Requirement: The current context names its repository
The system SHALL derive one context name. While a Team page is shown it SHALL name the team's repository. Otherwise it SHALL name the repository owning the selected chat's working directory: the repository of the deepest discovered worktree containing that path, matched by whole path segments. A remote session, or a path no discovered worktree contains, SHALL use the path's final non-empty component. With no selection there SHALL be no context name.

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

#### Scenario: A remote session uses its directory name
- **WHEN** the user selects a remote session whose working directory is `/srv/manga-studio`, even when a local worktree has that path
- **THEN** the context name is `manga-studio`

#### Scenario: The repository name replaces the directory name once discovered
- **GIVEN** no workspace snapshot has arrived yet
- **WHEN** the user selects a chat whose working directory is `/home/coder/kawai/.worktrees/adopt-tool-call-metrics`
- **THEN** the context name is `adopt-tool-call-metrics`
- **AND** it becomes `kawai` when a snapshot listing that worktree under repository `kawai` arrives

#### Scenario: A Team page names the team's repository
- **GIVEN** a chat of repository `manga-studio` is selected
- **WHEN** the user opens the Team page whose team is the repository `kawai`
- **THEN** the context name is `kawai`, and returning to Sessions makes it `manga-studio` again

#### Scenario: Nothing selected has no context name
- **WHEN** no chat is selected and no Team page is shown
- **THEN** there is no context name

### Requirement: The navigator heading shows the context name
The navigator heading SHALL show the context name. With no context name it SHALL show the server workspace name the browser title uses, and with neither it SHALL show `KAWAI`. Names SHALL keep their spelling, case, spaces, and Unicode characters. A long name SHALL truncate on one line without widening the navigator. The heading's tooltip SHALL stay `Kawai v<version>` when the server version is known.

#### Scenario: The heading follows the selected chat
- **WHEN** the user selects a chat whose context name is `kawai`, then a chat whose context name is `Manga Studio 日本`
- **THEN** the heading reads `kawai`, then `Manga Studio 日本`

#### Scenario: The heading falls back to the server workspace
- **WHEN** no chat is selected and the server reports default project directory `/projects/anime-studio`
- **THEN** the heading reads `anime-studio`

#### Scenario: The heading has a last-resort fallback
- **WHEN** no chat is selected and neither server directory has a usable name, or server information has not arrived
- **THEN** the heading reads `KAWAI`

#### Scenario: A long name keeps the navigator width
- **WHEN** the context name is longer than the heading's space
- **THEN** the heading shows it truncated on one line and the navigator keeps its width
- **AND** hovering the heading shows `Kawai v<version>`
