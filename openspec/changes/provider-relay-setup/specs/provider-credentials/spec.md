## ADDED Requirements

### Requirement: Imported credentials live in the server-owned store
The system SHALL store operator-imported credential values in one user-level
file (`~/.kawai/credentials.json`, created mode 0600 and never widened) that
maps environment variable names to values. Values SHALL NOT be stored in
SQLite, in repository or project files, or in any database backup. The store
SHALL exist only at the user level. A store file that is unreadable or
malformed SHALL be reported in the configuration-source listing and treated
as absent.

#### Scenario: Import writes only the store
- **WHEN** an operator imports a value for a credential variable through Settings
- **THEN** the value is stored only in `~/.kawai/credentials.json` with owner-only permissions, and no database row, log line, or repository file contains it

#### Scenario: Corrupt store degrades visibly
- **WHEN** the store file is malformed or unreadable
- **THEN** the configuration-source listing reports it with the reason, launches compose credentials from the server environment alone, and nothing fails silently

### Requirement: The credential UI is write-only
Read surfaces SHALL show each named variable's presence and source, and
SHALL NOT return a stored value, a prefix of it, or its length. Setting or
replacing a value SHALL require typing it anew; clearing SHALL be an
explicit act.

#### Scenario: Presence without value
- **WHEN** a client requests the credential listing
- **THEN** each variable shows set or absent with its source, and the response carries no value or prefix for any set variable

#### Scenario: Replace requires retyping
- **WHEN** an operator replaces a stored value
- **THEN** the input starts empty and the previous value is never rendered back

### Requirement: Store values override the server environment per variable
The effective credential source SHALL compose per variable: the process
environment, then the `AGENTBOARD_CHAT_ENV` seed, then the store — a store
value overrides the same-named lower source, a blank exports the variable
empty, an unset key shows the lower source through; the Settings env editor
writes the store. The listing SHALL show each source present per variable
and warn on conflicts. Injection, the authentication gate, and provider
usage pulls SHALL read this composition.

#### Scenario: Store overrides the ambient environment
- **WHEN** the process environment holds a variable and the store holds the same variable
- **THEN** launches, the authentication gate, and provider pulls see the store's value, and the listing marks the store as overriding

#### Scenario: A blank exports the variable empty
- **WHEN** the store holds an empty value for a variable the process environment sets
- **THEN** launches see the variable empty, and the listing shows it as blanked by the store

#### Scenario: Gate and spawn agree through the store
- **WHEN** a provider's token variable resolves only through the store
- **THEN** session creation passes the authentication check and the spawned agent receives that same value

### Requirement: Legacy Settings credentials migrate to the store at upgrade
At the first startup after adoption, the server SHALL move every value of
the Settings provider-env map once into the credential store and clear the
map from `app_settings`; the move SHALL be recorded by a stamp so a crash
retries safely, and no credential value SHALL be written to SQLite again.

#### Scenario: Migration moves the map once
- **WHEN** the server starts with a non-empty Settings provider-env map in `app_settings`
- **THEN** the store holds every map value, the map row is gone, and a restart performs no second move

#### Scenario: A restored pre-upgrade backup re-runs the migration
- **WHEN** a database backup taken before the upgrade is restored
- **THEN** the next startup moves its map values into the store the same way

### Requirement: Registered secret names stay withheld
Every credential variable named at any catalog layer, every header variable,
and every store key is registered; removing a provider entry, disabling an
id, or clearing a binding SHALL NOT stop withholding its names. The retained
names persist as names only.

#### Scenario: Removing a provider keeps its names withheld
- **WHEN** an operator removes a provider entry that named a credential variable
- **THEN** no Claude or Codex launch receives that variable under its own name afterwards

#### Scenario: A disabled entry's variables stay withheld
- **WHEN** a user-level entry is disabled
- **THEN** its credential and header variables remain withheld from every launch

### Requirement: Store changes apply at the next launch
Importing, replacing, or clearing a credential SHALL take effect at the next
agent launch or catalog-driven read without a server restart. Running
processes keep their environment.

#### Scenario: Import then create
- **WHEN** an operator imports a previously missing token variable and immediately creates a session
- **THEN** creation succeeds without a restart

#### Scenario: Running session keeps its environment
- **WHEN** a credential changes while an agent is running
- **THEN** the running process keeps its previous environment until its next launch
