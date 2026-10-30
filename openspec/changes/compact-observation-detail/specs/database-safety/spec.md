# Spec Delta

## ADDED Requirements

### Requirement: Pruned space returns to the file
Kawai SHALL keep the database in incremental auto-vacuum mode and release free pages after each pruning pass. A database not yet in that mode SHALL be converted once at startup, after the startup backup and every pending migration and before serving, outside any transaction. A conversion that fails SHALL be logged, leave the database usable in its previous mode, and SHALL NOT prevent startup; the next start SHALL try again.

#### Scenario: First start after upgrade
- **WHEN** a 729 MB database in no-vacuum mode, half of it deleted by a migration, starts
- **THEN** after the migrations the database is converted to incremental mode, the file shrinks to its live pages, and the server then serves

#### Scenario: Pruning shrinks the file
- **WHEN** a pruning pass deletes expired observations on a converted database
- **THEN** the freed pages are released and the file and the next backup shrink accordingly

#### Scenario: Conversion fails
- **WHEN** the conversion fails for lack of disk space
- **THEN** the failure is logged, the database keeps its contents and previous mode, the server starts, and the next start retries the conversion

#### Scenario: Already converted
- **WHEN** a database already in incremental mode starts
- **THEN** no full compaction runs
