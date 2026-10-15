# Spec Delta

## Purpose

Keeps Kawai's SQLite database recoverable. The schema carries a version, and later schema changes are numbered migrations that apply whole or not at all. Online backups are taken without ever failing a live commit, verified, and rotated beside the database, with a documented restore procedure.

## ADDED Requirements

### Requirement: The database records its schema version
Kawai SHALL keep a `schema_migrations` table with each applied version's number, name, time, build version, and pre-migration backup. On first start of this build it SHALL run the existing schema steps unchanged and record version 1 as the baseline. Every later schema change SHALL be a numbered migration.

#### Scenario: First start records the baseline
- **WHEN** this build starts on a database with no `schema_migrations` table
- **THEN** the existing tables and rows are unchanged, and version 1 `baseline` is recorded

#### Scenario: A fresh database
- **WHEN** this build starts with no database file
- **THEN** the full schema exists and every known migration is recorded

### Requirement: Migrations apply whole after a backup
Before each pending migration Kawai SHALL take a pre-migration backup, then apply the migration and record its version in one transaction. A failed backup or a failed migration SHALL roll back, leave the database at its previous version, and refuse to start, naming the migration and the backup.

#### Scenario: A migration throws
- **WHEN** migration 3's statements fail midway
- **THEN** none of its changes remain, version 3 is not recorded, and the server exits naming migration 3 and its backup

#### Scenario: Migrations apply in order
- **WHEN** the database is at version 1 and the build knows versions 2 and 3
- **THEN** a backup precedes each, and both are recorded in order

### Requirement: A database newer than the build refuses to start
When the database's highest version is greater than the build's newest migration, Kawai SHALL refuse to start without writing anything, naming both versions, the newest backup taken before that version, and the restore procedure. No override SHALL exist.

#### Scenario: Running an older build
- **WHEN** a build that knows version 2 starts on a database at version 3
- **THEN** the server exits with a message naming versions 3 and 2 and the `pre-migration-3` backup, and the database file is unchanged

#### Scenario: Equal versions start
- **WHEN** the database's version equals the build's newest
- **THEN** the server starts and applies nothing

### Requirement: Backups are online, verified, and never fail a live commit
Kawai SHALL take backups from its own connection outside any transaction, write them to a temporary file, then rename it, and run an integrity check on the copy over a separate read-only connection. A copy that fails the check SHALL be marked corrupt and kept out of rotation. A backup SHALL never cause a commit to fail.

#### Scenario: A backup during activity
- **WHEN** an interval backup runs while agents send mail
- **THEN** every mail commit succeeds, and the backup file passes its integrity check

#### Scenario: A failed check
- **WHEN** a backup file fails its integrity check
- **THEN** it is renamed as corrupt, the failure is logged and shown, and the previous good backups stay

### Requirement: Backups run on a schedule and rotate
Kawai SHALL take a backup at startup, hourly while the database has changed, and before each migration, in `~/.agentboard/backups/`. It SHALL keep the newest 24 interval and 7 startup backups and every pre-migration backup of the newest 3 migrations, deleting older ones. The newest backup per reason SHALL be shown read-only.

#### Scenario: An idle hour
- **WHEN** an hour passes with no database change since the last backup
- **THEN** no interval backup is taken

#### Scenario: Rotation
- **WHEN** a 25th interval backup is written
- **THEN** the oldest interval backup is deleted, and startup and pre-migration backups are untouched

### Requirement: Restore is documented and backups stay on the host
Kawai SHALL document how to restore a backup: stop the server, move the database and any journal aside together, copy the backup in, check integrity, and start. The procedure SHALL state what a restore does not recover, and that backups share the host's disk and copying them elsewhere is the owner's choice. Kawai SHALL never send a backup anywhere.

#### Scenario: Restoring before a migration
- **WHEN** the owner follows the procedure with the `pre-migration-3` backup and starts a build that knows version 2
- **THEN** the server starts at version 2 with the backup's rows

#### Scenario: Mail in flight at the snapshot
- **WHEN** the restored snapshot holds a message as claimed, and the message was delivered after the snapshot
- **THEN** startup reconciliation confirms it from the recipient's transcript or holds it as uncertain, and never silently re-sends it
