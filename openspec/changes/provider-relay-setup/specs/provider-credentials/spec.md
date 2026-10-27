## ADDED Requirements

### Requirement: Imported credentials live in the server-owned store
Credential values SHALL be stored in one user-level file
(`~/.kawai/credentials.json`, mode 0600, never widened) as versioned
entries carrying a kind (secret-source, delivered only through a binding;
or launch-env, delivered unchanged) and a value set, blank, or absent.
Values SHALL NOT be stored in SQLite, repository files, or backups taken
after the migration commit. An unreadable, unsafe, or malformed store is
reported and reads as absent for resolution — lower sources compose.

#### Scenario: Import writes only the store
- **WHEN** an operator imports a value for a credential variable through Settings
- **THEN** the value is stored only in `~/.kawai/credentials.json` with owner-only permissions, and no database row, log line, or repository file contains it

#### Scenario: Corrupt store degrades visibly
- **WHEN** the store file is malformed or unreadable
- **THEN** the configuration-source listing reports it with a fixed safe reason, launches compose credentials from the process environment and chat-env seed as if the store were absent, mutations refuse with the prior bytes standing until manual repair, and nothing fails silently

#### Scenario: Invalid store is never salvaged
- **WHEN** the document carries an unsupported version, an unknown kind, or an invalid variable name or entry shape
- **THEN** the store reads as malformed — reported in the listing, resolution composing the lower sources — and mutations refuse; no salvage pass rewrites the prior bytes

#### Scenario: Unsafe permissions refuse every access
- **WHEN** the file carries group or other permission bits
- **THEN** reads and mutations refuse with a fixed reason and the file is never chmodded; a 0400 file still reads, and an explicit save may replace it atomically with a fresh 0600 file

#### Scenario: Gates precede any cached value
- **WHEN** an entry is cached and the next access observes a symlink, a foreign owner, or an unsafe mode on the store path
- **THEN** the access refuses and the cached entry is never served

#### Scenario: Applied and durable report separately
- **WHEN** the atomic rename commits but the directory fsync fails
- **THEN** the save reports applied but not durable, the new content stands with no rollback or retry, and no caller — a Settings warning or the Settings-map migration — treats the outcome as durable

#### Scenario: Secret-source writes retain the name first
- **WHEN** an entry is set or reclassified as a secret source
- **THEN** its name, never its value, is persisted to the retained-names registry before the write reports success, and a missing or failing registry collaborator refuses the write before the file changes

#### Scenario: Blank is a stored state for both kinds
- **WHEN** a blank value is stored for either kind
- **THEN** it persists as blank, never as unset, and later resolution exports the variable empty over the lower sources

### Requirement: The credential UI is write-only
Read surfaces SHALL show each named variable's kind, presence, and source,
and SHALL NOT return a stored value, a prefix of it, or its length, whatever
the variable is named. Setting or replacing a value SHALL require typing it
anew; clearing SHALL be an explicit act; reclassifying an entry between
secret source and launch-env entry SHALL be an explicit act.

#### Scenario: Presence without value
- **WHEN** a client requests the credential listing
- **THEN** each variable shows set or absent with its kind and source, and the response carries no value or prefix for any set variable

#### Scenario: Replace requires retyping
- **WHEN** an operator replaces a stored value
- **THEN** the input starts empty and the previous value is never rendered back

#### Scenario: Errors carry fixed safe text only
- **WHEN** any store read, mutation, or listing fails or reports a state
- **THEN** its text is a fixed safe reason naming the path class and reason code, carrying no value, prefix, length, parser message, or cause chain, and an invalid raw input is never echoed back as a name

### Requirement: Credential resolution composes per variable
The effective credential source SHALL compose per variable, last writer
winning: process env, then the chat-env seed, then the store — a store
entry overrides the lower source, a blank exports empty, an unset key
passes through. Injection, the auth gate, and provider pulls SHALL read
this composition. A launch SHALL receive the delivery composition:
launch-env entries as configured, minus every registered secret name — a
secret source never reaches a launch under its own name.

#### Scenario: Store overrides the ambient environment
- **WHEN** the process environment holds a variable and the store holds the same variable
- **THEN** the gate, injection, and provider pulls see the store's value, and the listing marks the store as overriding

#### Scenario: A launch-env entry is delivered unchanged
- **WHEN** the store holds a launch-env entry for a variable nothing registers
- **THEN** the launch receives that value exactly as the legacy Settings map delivered it, and the listing shows it as a launch-env entry

#### Scenario: A seed-only sibling key survives
- **WHEN** the chat-env seed holds two variables and the store holds a launch-env entry for only one of them
- **THEN** delivery composes per variable — the store's value for that variable, the seed's value for the other

#### Scenario: A secret source never rides the launch environment
- **WHEN** the store holds a secret source for a variable no binding uses
- **THEN** no launch receives that variable under its own name

#### Scenario: Gate and spawn agree through the store
- **WHEN** a provider's token variable resolves only through the store
- **THEN** session creation passes the authentication check and the spawned agent receives that same value inside its composed token variable

### Requirement: Legacy Settings credentials migrate to the store at upgrade
At the first startup after adoption, the server SHALL move every Settings
provider-env map entry once into the credential store and clear the map
from `app_settings`. The store file SHALL be written durably (atomic
rename, fsync) before any SQLite write; the map deletion and the migration
stamp SHALL commit in one transaction. A re-run SHALL absorb same-valued
entries and let the store win collisions, listing skips in the source
listing. No credential value SHALL be written to SQLite again.

#### Scenario: Migration moves the map once
- **WHEN** the server starts with a non-empty Settings provider-env map in `app_settings`
- **THEN** the store holds every map entry as launch-env entries, the map row is gone, and a restart performs no second move

#### Scenario: A crash before the database commit recovers
- **WHEN** the store file was written but the SQLite transaction never committed
- **THEN** the next startup re-runs the migration, absorbs the identically valued entries, resolves collisions with the store winning and the skips listed, and commits the map deletion with the stamp

#### Scenario: A restored pre-upgrade backup re-runs the migration
- **WHEN** a database backup taken before the upgrade is restored
- **THEN** the next startup moves its map entries into the store the same way

#### Scenario: Backups taken before the commit are named honestly
- **WHEN** the operator reads the migration documentation
- **THEN** it states that every backup taken before the migration's commit — including the upgrade's own startup snapshot — may hold the old map values, advises rotation, and states when rotation ages them out

### Requirement: Registered secret names stay withheld
Every credential variable named at any catalog layer in any state, every
header variable, every secret-source store key, and every retained name is
registered; removal, disabling, or clearing SHALL NOT stop withholding.
Retained names persist as names only. A launch-env entry whose name is
registered SHALL NOT be delivered under its own name: it stays inert and
the collision is reported naming the variable; unregistered launch-env
entries are delivered unchanged.

#### Scenario: Removing a provider keeps its names withheld
- **WHEN** an operator removes a provider entry that named a credential variable
- **THEN** no Claude or Codex launch receives that variable under its own name afterwards

#### Scenario: A disabled entry's variables stay withheld
- **WHEN** a user-level entry is disabled
- **THEN** its credential and header variables remain withheld from every launch

#### Scenario: An ambient route survives a Default launch
- **WHEN** nothing registers the base-URL or proxy variable a Default or wrapper launch would inherit
- **THEN** the launch keeps those ambient values exactly as before — they are not in the registered set

#### Scenario: A launch-env entry colliding with a registered name stays inert
- **WHEN** a launch-env entry's name is a registered credential name (a catalog binding or a retained name)
- **THEN** no launch receives that variable under its own name, and the listing reports the collision naming the variable and the supported credential setting

#### Scenario: Reclassification does not end withholding
- **WHEN** a secret-source key is reclassified as a launch-env entry while its name stays registered
- **THEN** the variable remains withheld from launches while the name is registered

### Requirement: Store changes apply at the next launch
Importing, replacing, clearing, or reclassifying a store entry SHALL take
effect at the next agent launch or catalog-driven read without a server
restart. Running processes keep their environment.

#### Scenario: Import then create
- **WHEN** an operator imports a previously missing token variable and immediately creates a session
- **THEN** creation succeeds without a restart

#### Scenario: Running session keeps its environment
- **WHEN** a store entry changes while an agent is running
- **THEN** the running process keeps its previous environment until its next launch
