# instance-identity Specification

## Purpose

Identify a running Kawai instance by its server workspace in browser tabs so users can distinguish instances serving different projects.

## Requirements

### Requirement: Workspace name leads the browser title
The browser title SHALL use `<workspace name> - Kawai`. The workspace name SHALL be the final non-empty slash-separated component of the server-configured default project directory, falling back to the server working directory when the configured directory has no usable name. Directory names SHALL retain their spelling, case, spaces, and Unicode characters.

#### Scenario: Configured project directory identifies the instance
- **WHEN** the server reports default project directory `/projects/anime-studio` and working directory `/opt/kawai`
- **THEN** the browser title is `anime-studio - Kawai`

#### Scenario: Working directory supplies the name
- **WHEN** no configured project directory name is available and the server working directory is `/projects/anime-studio/`
- **THEN** the browser title is `anime-studio - Kawai`

#### Scenario: Preserve a directory name literally
- **WHEN** the selected server directory is `/projects/Anime Studio 日本/`
- **THEN** the browser title is `Anime Studio 日本 - Kawai`

### Requirement: Title has a usable loading and missing-name fallback
The browser title SHALL be `Kawai` before server information is available or when neither server directory has a usable name. A failed server-information refresh SHALL preserve the last successfully derived title.

#### Scenario: Initial load has no server information
- **WHEN** the page opens and server information has not arrived or its initial request fails
- **THEN** the browser title is `Kawai`

#### Scenario: Root directories have no workspace name
- **WHEN** both server directories are absent, empty, or contain only `/` separators
- **THEN** the browser title is `Kawai`

#### Scenario: Refresh fails after a successful load
- **WHEN** the title is `anime-studio - Kawai` and a subsequent server-information request fails
- **THEN** the title remains `anime-studio - Kawai`

### Requirement: Title follows the server instance across navigation
The title SHALL derive from server information independently of selected sessions, discovered repositories, Team pages, filters, and browser-local default project settings. A successful server-information refresh SHALL update the title to match the reported directories.

#### Scenario: Navigate within one instance
- **WHEN** the server workspace is `anime-studio` and the user selects another project's session, opens a Team page, changes filters, or edits the browser's default project setting
- **THEN** the title remains `anime-studio - Kawai`

#### Scenario: Reconnect refreshes instance information
- **WHEN** a successful reconnect refresh reports a workspace directory named `manga-studio`
- **THEN** the title becomes `manga-studio - Kawai`
