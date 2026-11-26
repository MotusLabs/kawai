# Spec Delta

## MODIFIED Requirements

### Requirement: The New Session dialog points a team without groups to setup
When the New Session dialog creates a chat for a project path whose team the setup action would be offered to and for which the dialog offers no group to choose, it SHALL show a notice that the project has no team groups, with a link that closes the dialog and opens that team's Team page on the Members tab. User-level groups count as offered. The notice SHALL NOT block creating the chat, SHALL follow the project path as it changes, and SHALL NOT show for terminal sessions.

#### Scenario: A project without groups shows the notice
- **WHEN** the human opens the New Session dialog for a chat in a repository with no project group files and no user-level groups
- **THEN** the dialog offers no group and shows the missing-groups notice with a link to the team's Members tab

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

#### Scenario: User-level groups hide the notice
- **WHEN** `~/.kawai/groups/` defines `reviewers-sol` and the main checkout has no group files
- **THEN** the dialog offers `reviewers-sol` as the chat's group and shows no missing-groups notice

#### Scenario: Unparsed user-level files do not hide the notice
- **WHEN** `~/.kawai/groups/` holds only files that fail to parse and the main checkout has no group files
- **THEN** the dialog offers no group and shows the missing-groups notice

## ADDED Requirements

### Requirement: The setup preview names the user-level groups it would replace
The preview SHALL carry one warning for every starter group whose id names a user-level group file under `~/.kawai/groups/`, valid or not. The warning SHALL name that file and say that the written file replaces that group for this project. It SHALL NOT disable Confirm.

#### Scenario: A starter group that replaces a user-level group is warned
- **WHEN** `~/.kawai/groups/lead.md` defines `lead` and the human opens the setup preview
- **THEN** the preview warns that `lead.md` replaces `~/.kawai/groups/lead.md` for this project, and Confirm stays available

#### Scenario: No warning without a same-named user-level file
- **WHEN** `~/.kawai/groups/` holds `reviewers-sol.md` and `spec-verifiers.md` and the human opens the setup preview
- **THEN** the preview carries no warning about replacing a user-level group
