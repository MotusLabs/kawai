# Spec Delta

## Purpose

Names every runtime identifier an operator, script, or browser depends on after the product, Kawai. It also defines how installs, configurations, and browsers that still use the legacy `agentboard` names keep working or are migrated.

## ADDED Requirements

### Requirement: Operator environment variables use the KAWAI_ prefix
The server SHALL read each operator setting from `KAWAI_<NAME>`. While a transition window lasts, it SHALL also accept the matching legacy `AGENTBOARD_<NAME>` when `KAWAI_<NAME>` is unset or empty. When both are set, `KAWAI_<NAME>` SHALL win. Variables without a prefix, such as `TMUX_SESSION` and `LOG_FILE`, SHALL keep their names.

#### Scenario: New name configures the server
- **WHEN** the server starts with `KAWAI_REMOTE_HOSTS=host-a`
- **THEN** it polls `host-a`

#### Scenario: Legacy name still configures the server
- **WHEN** the server starts with `AGENTBOARD_CHAT_ENV` set and no `KAWAI_CHAT_ENV`
- **THEN** chat sessions use the provider environment from `AGENTBOARD_CHAT_ENV`

#### Scenario: New name wins over legacy name
- **WHEN** both `KAWAI_WS_DEFLATE=true` and `AGENTBOARD_WS_DEFLATE=false` are set
- **THEN** WebSocket compression is enabled

### Requirement: Legacy environment names log a deprecation warning
When a setting's value comes from a legacy `AGENTBOARD_<NAME>`, the server SHALL log one warning per variable per process that names both the legacy and the replacement variable. The warning SHALL NOT include the variable's value. Settings read from `KAWAI_<NAME>` SHALL log no deprecation warning.

#### Scenario: One warning per legacy variable
- **WHEN** the server starts with `AGENTBOARD_LOG_POLL_MS` set and reads it several times
- **THEN** exactly one warning names `AGENTBOARD_LOG_POLL_MS` and `KAWAI_LOG_POLL_MS`

#### Scenario: Secrets are not logged
- **WHEN** the value of `AGENTBOARD_CHAT_ENV` carries a gateway token
- **THEN** the deprecation warning does not contain the token

### Requirement: Default data lives in the Kawai home directory
With no database-path or log-file override, the server SHALL keep its database at `~/.kawai/kawai.db`, its log at `~/.kawai/kawai.log`, and its sibling data (chat wire logs, chat worker and background-task state, database backups, the tmux server PID file) in `~/.kawai/`. That directory also holds the existing `groups/`, `routing/`, `teams.json`, `outbound.json`, and `profiles.json` files. An explicit path override SHALL be used as given.

#### Scenario: Fresh install uses the Kawai home
- **WHEN** the server starts for the first time with neither `~/.kawai/kawai.db` nor `~/.agentboard/` present
- **THEN** it creates `~/.kawai/kawai.db` and writes its log to `~/.kawai/kawai.log`

#### Scenario: Explicit database path is honored
- **WHEN** the server starts with `KAWAI_DB_PATH=/tmp/x/k.db`
- **THEN** it opens `/tmp/x/k.db` and migrates no data

### Requirement: Legacy data directory is migrated on first start
When default paths apply, `~/.kawai/kawai.db` is missing, and `~/.agentboard/agentboard.db` exists, the server SHALL, before opening the database, move the legacy database with its journal, log, chat wire logs, chat worker and background-task state, backups, tmux PID file, and dev TLS files into `~/.kawai/`, renaming `agentboard.db` and `agentboard.log` to their Kawai names. It SHALL NOT move `~/.agentboard/app`, `~/.agentboard/bin`, or files it does not recognize.

#### Scenario: Existing sessions survive the move
- **WHEN** a server with chat sessions in `~/.agentboard/agentboard.db` restarts on the renamed build
- **THEN** the same sessions, conversations, tasks, and mail are present, read from `~/.kawai/kawai.db`

#### Scenario: Program files stay in place
- **WHEN** the migration runs while a service runs `~/.agentboard/app/bin/agentboard`
- **THEN** `~/.agentboard/app` and `~/.agentboard/bin` are unchanged

#### Scenario: Existing Kawai team files are kept
- **WHEN** `~/.kawai/teams.json` and `~/.kawai/groups/` exist before the migration
- **THEN** they are unchanged after it

#### Scenario: Background-task outcomes survive the move
- **WHEN** a chat had recorded background-task outcomes in `~/.agentboard/chat-tasks/` before the upgrade
- **THEN** the chat's tool rows show the same outcomes after the move

#### Scenario: Already migrated
- **WHEN** `~/.kawai/kawai.db` exists
- **THEN** nothing under `~/.agentboard/` is moved, even if `~/.agentboard/agentboard.db` also exists

### Requirement: The legacy database is backed up before it moves
Before moving any legacy entry, the server SHALL take a verified backup of the legacy database through the same copy and integrity check the database backups use, named with the `pre-rename` reason. If the backup fails or does not pass its check, the server SHALL move nothing and run this process on the legacy paths. Pre-rename backups SHALL be kept by rotation for the whole transition.

#### Scenario: Backup precedes the move
- **WHEN** the migration runs on a host with `~/.agentboard/agentboard.db`
- **THEN** a `pre-rename` backup that passes the integrity check exists before any entry moves, and it is under `~/.kawai/backups/` afterwards

#### Scenario: Failed backup stops the migration
- **WHEN** the pre-rename backup cannot be written or fails its integrity check
- **THEN** nothing under `~/.agentboard/` is moved and the server serves from `~/.agentboard/agentboard.db`

### Requirement: Existing database backups keep their rotation and recovery role
The migration SHALL rename each backup file that the database backups wrote under the legacy stem (`agentboard-<stamp>-<reason>.db`, including corrupt and partial copies) to the `kawai` stem, keeping stamp and reason, so rotation and recovery still find it. Files in the backups directory that the backups did not write SHALL keep their names.

#### Scenario: Migration backups stay findable
- **WHEN** `~/.agentboard/backups/` holds `agentboard-<stamp>-pre-migration-2.db` before the upgrade
- **THEN** `~/.kawai/backups/` holds `kawai-<stamp>-pre-migration-2.db`, and rotation counts it among the newest migrations' backups

#### Scenario: Owner files are untouched
- **WHEN** the backups directory holds a file the owner copied there under another name
- **THEN** it moves with the directory and keeps its name

### Requirement: The migration never runs while another process holds the legacy database
Before backing up or moving anything, the server SHALL check whether another process has the legacy database open. If one does, or if the check cannot be performed, it SHALL skip the migration, run this process on the legacy paths, and log why. A later start SHALL try again.

#### Scenario: Old instance still running
- **WHEN** a legacy dev server on another port has `~/.agentboard/agentboard.db` open while the renamed build starts
- **THEN** nothing is moved, the renamed build serves from the legacy paths, and the log names the reason

### Requirement: A data migration that cannot complete leaves the legacy data usable
If any legacy entry cannot be moved, the server SHALL put back every entry it already moved, log an error naming the entry and the cause, and run this process with the legacy `~/.agentboard/` paths. A partly migrated state SHALL NOT be left behind.

#### Scenario: Cross-device move fails
- **WHEN** `~/.kawai` is on a different filesystem and moving `agentboard.db` fails
- **THEN** the server logs the failure, keeps every legacy entry in `~/.agentboard/`, and serves from `~/.agentboard/agentboard.db`

### Requirement: The managed tmux session is named kawai
With no `TMUX_SESSION` override, the managed tmux session SHALL be `kawai`, and per-connection sessions SHALL be `kawai-ws-<connection>`. At startup, if a session named exactly `agentboard` exists and none named `kawai` does, the server SHALL rename `agentboard` to `kawai`. Before the first session refresh, it SHALL rewrite stored window targets from `agentboard:` to `kawai:`, so tracked sessions stay attached to their windows.

#### Scenario: Running windows carry over
- **WHEN** the renamed build starts while tmux has an `agentboard` session with three windows and no `kawai` session
- **THEN** the session is named `kawai` and all three windows appear as managed sessions

#### Scenario: Tracked sessions keep their windows
- **WHEN** a stored agent session points at window `agentboard:@42` and the tmux session is renamed
- **THEN** the session points at `kawai:@42`, stays active, and keeps its matched log, pin, and name

#### Scenario: Override is respected
- **WHEN** the server starts with `TMUX_SESSION=work`
- **THEN** it manages `work` and renames no session

### Requirement: Legacy per-connection tmux sessions are pruned
When startup pruning of orphaned per-connection sessions is enabled, it SHALL remove orphaned `agentboard-ws-*` sessions as well as `kawai-ws-*` sessions. Per-connection sessions in either form SHALL NOT appear as discovered external sessions.

#### Scenario: Leftover legacy viewer sessions are removed
- **WHEN** the server starts with an orphaned `agentboard-ws-abc` tmux session
- **THEN** that session is killed during startup pruning

### Requirement: Remote hosts on either name are recognized
When it discovers sessions on remote hosts, the server SHALL treat a remote session named either the managed session name or the legacy `agentboard` as managed. It SHALL skip per-connection sessions with either the `kawai-ws-` or the `agentboard-ws-` prefix.

#### Scenario: Remote host not yet upgraded
- **WHEN** a remote host still runs the legacy build with an `agentboard` session
- **THEN** its windows are listed as managed remote sessions, and the `agentboard-ws-*` sessions there are not listed

### Requirement: Browser settings carry over to the Kawai storage keys
The client SHALL persist its settings, theme, workspace, and session selection under `kawai-settings`, `kawai-theme`, `kawai-workspace`, and `kawai-session`. Before reading a store, if the new key is missing and the legacy `agentboard-*` key exists, the client SHALL copy the value to the new key and then remove the legacy key.

#### Scenario: Settings survive the upgrade
- **WHEN** a browser with saved settings under `agentboard-settings` loads the renamed client
- **THEN** the same settings are in effect, stored under `kawai-settings`, and `agentboard-settings` is gone

#### Scenario: New key is never overwritten
- **WHEN** both `kawai-theme` and `agentboard-theme` exist
- **THEN** `kawai-theme` is used unchanged

### Requirement: Service installers use Kawai service names
The systemd installer SHALL install and enable the user unit `kawai.service`. The launchd installer SHALL load the agents `com.kawai` and `com.kawai.logrotate`. Each SHALL install the release under `~/.kawai/app` with `bin/kawai`. When a legacy `agentboard.service` or `com.agentboard` agent exists, the installer SHALL stop it and remove its definition before starting the Kawai one.

#### Scenario: Re-running the installer on a legacy host
- **WHEN** `systemd/install.sh` runs on a host with an enabled `agentboard.service`
- **THEN** `agentboard.service` is stopped, disabled, and removed, and `kawai.service` runs `~/.kawai/app/bin/kawai`

#### Scenario: Data is not duplicated by the installer
- **WHEN** the installer replaces a legacy service
- **THEN** it does not copy or delete the database; the server's own first-start migration moves the data

### Requirement: Restarts target the supervisor that launched the process
After an update under systemd, the server SHALL restart the unit from `KAWAI_SYSTEMD_UNIT` (or the legacy override), else `kawai.service`. Under launchd, it SHALL restart the label from `KAWAI_LAUNCHD_LABEL` (or the legacy override), else the process's own service name. A host still on `agentboard.service` SHALL be restarted through that unit.

#### Scenario: Legacy unit restarts itself
- **WHEN** an update completes on a server launched by an `agentboard.service` that exports `AGENTBOARD_SYSTEMD_UNIT=agentboard.service`
- **THEN** `agentboard.service` is restarted

#### Scenario: Legacy unit without an override
- **WHEN** an update completes on a server launched by an `agentboard.service` that exports no unit override
- **THEN** the server restarts the unit that launched it (`agentboard.service`), not `kawai.service`
