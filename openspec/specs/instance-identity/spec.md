# instance-identity Specification

## Purpose

Identify a running Kawai instance by its server workspace in browser tabs so users can distinguish instances serving different projects.

## Requirements

### Requirement: Workspace name leads the browser title
The browser title SHALL use `<workspace name> - Kawai` when there is no context name (workspace-navigation, "The current context names its repository"). The workspace name SHALL be the final non-empty slash-separated component of the server-configured default project directory, falling back to the server working directory when the configured directory has no usable name. Directory names SHALL retain their spelling, case, spaces, and Unicode characters.

#### Scenario: Configured project directory identifies the instance
- **WHEN** no chat is selected, no Team page is shown, and the server reports default project directory `/projects/anime-studio` and working directory `/opt/kawai`
- **THEN** the browser title is `anime-studio - Kawai`

#### Scenario: Working directory supplies the name
- **WHEN** no chat is selected, no Team page is shown, no configured project directory name is available, and the server working directory is `/projects/anime-studio/`
- **THEN** the browser title is `anime-studio - Kawai`

#### Scenario: Preserve a directory name literally
- **WHEN** no chat is selected, no Team page is shown, and the selected server directory is `/projects/Anime Studio 日本/`
- **THEN** the browser title is `Anime Studio 日本 - Kawai`

### Requirement: Title has a usable loading and missing-name fallback
With no context name, the browser title SHALL be `Kawai` before server information is available or when neither server directory has a usable name. A failed server-information refresh SHALL preserve the last successfully derived workspace name.

#### Scenario: Initial load has no server information
- **WHEN** the page opens with no chat selected and no Team page shown, and server information has not arrived or its initial request fails
- **THEN** the browser title is `Kawai`

#### Scenario: Root directories have no workspace name
- **WHEN** no chat is selected, no Team page is shown, and both server directories are absent, empty, or contain only `/` separators
- **THEN** the browser title is `Kawai`

#### Scenario: Refresh fails after a successful load
- **WHEN** the title is `anime-studio - Kawai` and a subsequent server-information request fails
- **THEN** the title remains `anime-studio - Kawai`

#### Scenario: A context name needs no server information
- **WHEN** server information has not arrived and the user selects a chat whose context name is `kawai`
- **THEN** the browser title is `kawai - Kawai`

### Requirement: Title follows the current context
When there is a context name (workspace-navigation, "The current context names its repository"), the browser title SHALL be `<context name> - Kawai`, keeping its spelling, case, spaces, and Unicode characters. The title SHALL change whenever the context name changes. Project and host filters and the browser-local default project setting SHALL NOT affect the title except through the selection they change.

#### Scenario: Selecting a chat titles its repository
- **GIVEN** the server workspace is `anime-studio`
- **WHEN** the user selects a chat whose working directory is in a worktree of the discovered repository `kawai`
- **THEN** the browser title is `kawai - Kawai`

#### Scenario: A Team page titles the team's repository
- **GIVEN** a chat of repository `kawai` is selected
- **WHEN** the user opens the Team page of the discovered repository `Manga Studio 日本`, whose main checkout is `/projects/manga`
- **THEN** the browser title is `Manga Studio 日本 - Kawai`

#### Scenario: Clearing the selection returns to the instance title
- **GIVEN** the server workspace is `anime-studio` and the title is `kawai - Kawai`
- **WHEN** the selection is cleared and no Team page is shown
- **THEN** the browser title is `anime-studio - Kawai`

#### Scenario: Filters and browser defaults leave the title alone
- **WHEN** the title is `kawai - Kawai` and the user changes the browser's default project setting, or changes the project or host filters so the selected session stays visible
- **THEN** the title remains `kawai - Kawai`

#### Scenario: A filter that moves the selection retitles
- **GIVEN** the server workspace is `anime-studio`, the title is `kawai - Kawai`, and no Team page is shown
- **WHEN** the user changes the filters so the selected chat is hidden and the app selects the first visible session, a chat of repository `manga-studio`
- **THEN** the browser title is `manga-studio - Kawai`
- **AND** when a later filter leaves no session visible and the selection is cleared, the title is `anime-studio - Kawai`

### Requirement: Workspace fallback follows server information
A successful server-information refresh SHALL update the workspace name to match the reported directories, and the browser title SHALL show it whenever there is no context name.

#### Scenario: Reconnect refreshes instance information
- **WHEN** no chat is selected, no Team page is shown, and a successful reconnect refresh reports a workspace directory named `manga-studio`
- **THEN** the title becomes `manga-studio - Kawai`
