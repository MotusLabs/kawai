## Purpose

Let the human give a project its first team in one step: kawai writes a starter set of editable role-group files from templates it ships, and never touches group files that already exist.

## ADDED Requirements

### Requirement: The setup action is offered to a team without project groups
The Team page SHALL offer **Set up team** when the team's main checkout has no group file in `<main-checkout>/.kawai/groups/`, whether or not user-level groups exist. It SHALL NOT be offered when that directory holds any group file, valid or not. It SHALL be offered for git repositories and plain directories alike, and only to the human: no agent tool SHALL run it.

#### Scenario: A new repository is offered the action
- **WHEN** the human opens the Team page of a repository with no `.kawai/groups/` directory
- **THEN** the Members tab offers Set up team

#### Scenario: User-level groups do not hide the action
- **WHEN** `~/.kawai/groups/` defines `reviewers-sol` and the main checkout has no group files
- **THEN** the Members tab offers Set up team

#### Scenario: Any project group file hides the action
- **WHEN** the main checkout's `.kawai/groups/` holds one file `notes.md` that fails to parse
- **THEN** the Members tab does not offer Set up team

#### Scenario: Agents cannot run the setup
- **WHEN** an agent looks for a team tool that writes group files
- **THEN** no such tool exists

### Requirement: The setup previews the starter team before writing
Before writing, the action SHALL show each starter group's id, label, description, workers with their caps, and the cross-model review flag, together with the target directory and a warning for every starter worker the team's resolved catalog does not define. Nothing SHALL be written until the human confirms; cancelling SHALL write nothing.

#### Scenario: The preview lists the three groups
- **WHEN** the human chooses Set up team
- **THEN** the preview shows `lead` with one `codex-sol` worker, `devs` with one `opus` and one `codex-sol` worker, and `reviewers` with one `codex-sol` and one `opus` worker and cross-model review on

#### Scenario: A missing worker profile is warned
- **WHEN** the team's resolved catalog defines `opus` but not `codex-sol`
- **THEN** the preview warns that `codex-sol` is not defined and those slots will not staff, and still allows confirming

#### Scenario: Cancelling writes nothing
- **WHEN** the human cancels the preview
- **THEN** no file or directory is created

### Requirement: Confirming writes the starter group files
On confirmation the server SHALL create `<main-checkout>/.kawai/groups/` if absent and write `lead.md`, `devs.md`, and `reviewers.md` with the shipped templates' exact bytes, from any worktree of the team. It SHALL NOT commit, stage, or edit any other file. Every open view of the team SHALL then show the new groups without reloading.

#### Scenario: Setup from a linked worktree writes to the main checkout
- **WHEN** the human confirms setup on the Team page of a chat whose project path is a linked worktree
- **THEN** the three files appear under the main checkout's `.kawai/groups/`, not the worktree's

#### Scenario: Written files equal the templates
- **WHEN** setup completes
- **THEN** each written file's bytes equal the template of the same name shipped in kawai's `config/groups/`

#### Scenario: Nothing is committed
- **WHEN** setup completes in a git repository
- **THEN** the index and HEAD are unchanged and the three files show as untracked

#### Scenario: Other views follow
- **WHEN** two browser tabs show the team and one completes setup
- **THEN** the other tab lists `lead`, `devs`, and `reviewers` without reloading

### Requirement: Setup never overwrites a group file
The server SHALL refuse the whole setup, writing nothing, when the project groups directory holds any group file at confirmation time. Each starter file SHALL be created exclusively; a file that appears between the check and its creation SHALL be kept, and the result SHALL name the files created and the files skipped.

#### Scenario: A file added after the preview refuses the setup
- **WHEN** `devs.md` is created in the project groups directory while the preview is open, and the human confirms
- **THEN** the setup is refused naming `devs.md`, and no file is written

#### Scenario: A racing file is kept
- **WHEN** another writer creates `reviewers.md` after the confirmation check passes but before kawai creates it
- **THEN** kawai keeps that file's bytes, writes `lead.md` and `devs.md`, and reports `reviewers.md` as skipped

#### Scenario: A symlinked groups directory is refused
- **WHEN** the main checkout's `.kawai` or `.kawai/groups` is a symbolic link
- **THEN** the setup is refused naming the link, and nothing is written through it

#### Scenario: An unwritable directory is reported
- **WHEN** the main checkout's `.kawai/` cannot be written
- **THEN** the setup reports the error inline, names any file already created, and no partially written group file remains

### Requirement: The starter templates define a working team
The shipped templates SHALL parse with no error or warning against the shipped catalogs. `lead` SHALL be the Team Lead, able to create tasks and plans, with `max: 1` on `codex-sol`. `devs` SHALL be developers on `opus` and `codex-sol`, one each. `reviewers` SHALL be read-only reviewers on `codex-sol` and `opus`, one each, with `crossModelReview: true`. Each body SHALL hold a generic role prompt with no project-specific content.

#### Scenario: Templates parse clean
- **WHEN** the shipped templates are loaded as a team's project groups with the shipped catalogs
- **THEN** the group catalog reports no error and no warning, and the three groups have the workers and caps above

#### Scenario: Reviewers require cross-model review
- **WHEN** the `reviewers` template is parsed
- **THEN** its group has cross-model review on

### Requirement: The New Session dialog points a team without groups to setup
When the New Session dialog creates a chat for a project path whose team the setup action would be offered to, it SHALL show a notice that the project has no team groups, with a link that closes the dialog and opens that team's Team page on the Members tab. The notice SHALL NOT block creating the chat, SHALL follow the project path as it changes, and SHALL NOT show for terminal sessions.

#### Scenario: A project without groups shows the notice
- **WHEN** the human opens the New Session dialog for a chat in a repository with no project group files
- **THEN** the dialog shows the missing-groups notice with a link to the team's Members tab

#### Scenario: The link opens the Members tab
- **WHEN** the human follows the notice's link
- **THEN** the dialog closes and the Team page of that project's team opens on the Members tab, showing Set up team

#### Scenario: The chat can still be created
- **WHEN** the notice is shown and the human creates the chat without following the link
- **THEN** the chat is created with no group, as before

#### Scenario: A project with groups shows no notice
- **WHEN** the human changes the dialog's project path to a repository whose main checkout has group files
- **THEN** the notice disappears

#### Scenario: Terminal sessions show no notice
- **WHEN** the human switches the dialog to a terminal session for a project without groups
- **THEN** no missing-groups notice is shown

### Requirement: Set-up groups are editable files the Members tab names
After setup, the Members tab SHALL list the three starter groups, each naming its written file as its source, and SHALL state that the files are edited directly and that prompt changes apply to future agent starts. Kawai SHALL treat the written files as ordinary project group files from then on.

#### Scenario: Rows name the written files
- **WHEN** setup completes
- **THEN** the `lead`, `devs`, and `reviewers` rows each name their file under `<main-checkout>/.kawai/groups/` as the source

#### Scenario: An edit is picked up like any group edit
- **WHEN** the human changes `devs.md` to set `workers: { opus: 2, codex-sol: 1 }` after setup
- **THEN** the Members tab shows two `opus` slots for `devs`, and the setup action stays hidden
