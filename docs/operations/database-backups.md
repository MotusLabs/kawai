# Database backups and restore

Kawai keeps everything it owns (chat sessions, team mail, tasks, plans, product strategy, settings) in one SQLite file. This page covers how that file is versioned and backed up, and how to restore a backup.

The examples assume the default data directory, `~/.agentboard/`. With `AGENTBOARD_DB_PATH` set, read every path below relative to that file's directory instead.

## Layout

```
~/.agentboard/
  agentboard.db                  the live database
  agentboard.db-journal          present only while a write is in progress, or after a crash
  backups/
    agentboard-20261015T090000000Z-startup.db
    agentboard-20261015T100000000Z-interval.db
    agentboard-20261016T080000000Z-pre-migration-2.db
    agentboard-20261015T110000000Z-interval.db.corrupt
    agentboard-20261015T120000000Z-interval.db.partial
```

Each backup is named `agentboard-<UTC time>-<reason>.db`. The time is the moment of the snapshot, to the millisecond. The reasons are:

- `startup`: taken at every server start, after the version check and before any schema step.
- `interval`: taken hourly, but only when the database changed since the last snapshot this server process took.
- `pre-migration-<n>`: taken before schema migration `n` runs. The migration starts only after this backup is in place and has passed its integrity check.

A backup is written to `<name>.partial`, flushed to disk, and then renamed, so a file without a suffix is always complete. Each copy is then checked with `PRAGMA integrity_check` over a separate read-only connection. A copy that fails the check is renamed `<name>.corrupt`, logged as `db_backup_failed`, and never counted as a backup. A `.partial` file left over means the server stopped while writing it. Both kinds are kept only for diagnosis.

Kawai only reads, rotates, or deletes files that match this naming. Any other file you put in `backups/` stays untouched.

## How a backup is taken

Backups are online. They run on the server's own database connection, outside any transaction, and copy the database with SQLite's `serialize()` under a shared lock held for a few milliseconds. A backup never makes a commit fail: the server's own writes cannot run during the copy, and another process waits within its busy timeout. The live file is never copied with `cp`, and nothing is attached to the live connection.

## Rotation

Kawai rotates by reason:

| Kind | Kept |
| --- | --- |
| `interval` | the newest 24 |
| `startup` | the newest 7 |
| `pre-migration-<n>` | every backup of the newest 3 migrations |
| `.corrupt` | the newest 3 |
| `.partial` | the newest 3, never counting the one being written |

Rotation runs at startup and after each snapshot. A new `interval` backup only removes older `interval` backups; startup and pre-migration backups are untouched by it.

## Schema versions

The database records its schema version in the `schema_migrations` table: one row per applied version, with its name, time, the build that applied it, and the path of its pre-migration backup. `PRAGMA user_version` mirrors the highest version for outside tools.

Version 1, `baseline`, is the schema as it stood before versions existed. It is recorded the first time a build with versions starts on an existing database, and every table and row stays as it was. Each later schema change is a numbered migration. It runs after its backup, in one transaction together with its version row. If a migration fails, it is rolled back: the database stays at the previous version, and the server refuses to start, naming the migration and its backup.

## When the server refuses to start

**The database is newer than the build.** This happens when you run an older build against a database that a newer build has already migrated. The server exits before writing anything to the database. The message names the database's version, the newest version this build knows, the newest `pre-migration-<n>` backup taken before the first version this build does not know, and this page. There is no override: an older build could write rows that break rules it does not know. To go back to the older build, restore that backup (below), or run a build that knows the database's version.

**A migration or its backup failed.** The message names the migration and the backup. The database is left at its previous version. Fix the cause the message reports (for example, disk space for the backup) and start again, or restore a backup.

## Restoring a backup

1. **Stop the server.** No Kawai process may have the database open.
2. **Move the database and any journal aside together.** Move `agentboard.db` and, if it exists, `agentboard.db-journal` into another directory as a pair. A leftover journal belongs to its database: keeping it beside a restored file would corrupt it.

   ```sh
   mkdir -p ~/agentboard-aside
   mv ~/.agentboard/agentboard.db ~/agentboard-aside/
   [ -e ~/.agentboard/agentboard.db-journal ] && mv ~/.agentboard/agentboard.db-journal ~/agentboard-aside/
   ```

3. **Copy the chosen backup in** as `agentboard.db`. Copy it rather than moving it, so the backup itself stays in rotation.

   ```sh
   cp ~/.agentboard/backups/agentboard-20261016T080000000Z-pre-migration-2.db ~/.agentboard/agentboard.db
   ```

4. **Check its integrity.** Either command must report `ok` and nothing else:

   ```sh
   sqlite3 ~/.agentboard/agentboard.db 'PRAGMA integrity_check'
   bun -e "const { Database } = require('bun:sqlite'); console.log(new Database(process.argv[1], { readonly: true }).query('PRAGMA integrity_check').all())" ~/.agentboard/agentboard.db
   ```

5. **Start the server.** It opens at the backup's schema version, takes a `startup` backup, and applies any migrations the build knows beyond that version, each after its own backup.

To go back to an older build after a migration, restore the `pre-migration-<n>` backup of the first migration that build does not know. That file is the database as it stood just before the migration.

## What a restore does not bring back

- **Rows written after the snapshot.** Mail, tasks, journal notes, plan and strategy edits, and session records created or changed after the backup are absent from the restored database. The file you moved aside keeps them.
- **The sidecars beside the database:** `chat-wire/`, `chat-tasks/`, and `chat-workers/`. They are not part of the backup, and a restore neither rolls them back nor removes them.
- **The SDK transcripts** under the agents' own directories (for example `~/.claude/projects/`). These are never backed up by Kawai.

Mail that the restored snapshot holds as claimed or pushed is not re-sent blindly. On start, mailbox reconciliation re-derives each such message's delivery: it is confirmed from the recipient's transcript, or held as uncertain for you to retry or discard in the Mailbox tab.

## Backups stay on the host

Backups are written to the same disk as the database. If you lose that disk, you lose both. Copying `~/.agentboard/backups/` elsewhere, such as to another disk or another machine, is up to you. Kawai never sends a backup anywhere.
