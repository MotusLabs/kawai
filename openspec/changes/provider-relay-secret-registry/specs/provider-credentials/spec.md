## ADDED Requirements

### Requirement: Registered secret names stay withheld
Every credential variable named at any parsed catalog layer, in any entry
state, and every retained name (persisted as names only) SHALL be withheld
from every launch under its own name; removal or dropping out of the
resolved catalog SHALL NOT end it. A registered launch-env entry stays
inert, and a branch that must compose a registered name refuses before
spawning, naming it. Unregistered entries pass unchanged.

#### Scenario: Removing a provider keeps its names withheld
- **WHEN** an operator removes a provider entry that named a credential variable
- **THEN** no Claude or Codex launch receives that variable under its own name afterwards

#### Scenario: A dropped entry's variables stay withheld
- **WHEN** an entry that names a credential variable parses at a catalog layer but leaves the resolved catalog — the trusted invariants drop it, or its file is replaced without it
- **THEN** its credential variables remain withheld from every launch

#### Scenario: An ambient route survives a Default launch
- **WHEN** nothing registers the base-URL or proxy variable a Default or wrapper launch would inherit
- **THEN** the launch keeps those ambient values exactly as before — they are not in the registered set

#### Scenario: A launch-env entry colliding with a registered name stays inert
- **WHEN** a launch-env entry's name is a registered credential name (a catalog binding or a retained name)
- **THEN** no launch receives that variable under its own name, and a branch that would have to compose it refuses the launch naming the variable
