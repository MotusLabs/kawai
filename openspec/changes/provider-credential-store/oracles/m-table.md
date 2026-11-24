# Table M — blind reading, commit A1 (inputs only)

Task 1.1 of `provider-credential-store`. This file is commit A1: the design's
table M with every output `?`, copied unchanged from `design.md`. The
cross-family advisor fills the outputs from this change's spec scenarios
(`specs/provider-credentials/spec.md`, requirement "Legacy Settings
credentials migrate to the store at upgrade", and the store requirement's
"Applied and durable report separately") and the umbrella text quoted in
`design.md`'s appendix (D1 "Upgrade migration", crash table, D12-2/6) alone,
without the author's reading. Commit A2 adds the author's outputs; the two
are diffed and each disagreement is resolved in this file.

Axes: stamp (absent / present) × map row (absent / empty / non-empty) ×
store before (missing / ok / unreadable-unsafe-malformed) × per-entry
relation (name absent in store / same value / different value / name
registered) × store write outcome (durable / applied-not-durable / refused)
× crash point (none / before store write / after store write, before the
SQLite transaction / after the transaction) × mode (normal start / restored
pre-upgrade backup / downgrade to a pre-change binary).

| Id | Stamp | Map | Store before | Entry relation | Write outcome | Crash point | Mode | Store after | Map/stamp after | Listing shows | Delivery meanwhile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | present | absent | * | — | — | none | normal | ? | ? | ? | ? |
| M2 | present | non-empty | * | * | — | none | normal | ? | ? | ? | ? |
| M3 | absent | absent or empty | * | — | — | none | normal | ? | ? | ? | ? |
| M4 | absent | non-empty | missing or ok | name absent | durable | none | normal | ? | ? | ? | ? |
| M5 | absent | non-empty | ok | same value | durable | none | normal | ? | ? | ? | ? |
| M6 | absent | non-empty | ok | different value | durable | none | normal | ? | ? | ? | ? |
| M7 | absent | non-empty | missing or ok | name registered | durable | none | normal | ? | ? | ? | ? |
| M8 | absent | non-empty | missing or ok | * | applied-not-durable | none | normal | ? | ? | ? | ? |
| M9 | absent | non-empty | missing or ok | * | refused (write-failed) | none | normal | ? | ? | ? | ? |
| M10 | absent | non-empty | unreadable-unsafe-malformed | * | — | none | normal | ? | ? | ? | ? |
| M11 | absent | non-empty | * | * | * | before store write | normal | ? | ? | ? | ? |
| M12 | absent | non-empty | ok | * | durable | after store write, before transaction | normal | ? | ? | ? | ? |
| M13 | present | absent | ok | — | — | after transaction | normal | ? | ? | ? | ? |
| M14 | absent | non-empty | ok (later entries) | same or different | durable | none | restored pre-upgrade backup | ? | ? | ? | ? |
| M15 | absent | non-empty | ok, operator cleared a migrated name while M8 repeated | name absent | durable | none | normal | ? | ? | ? | ? |
| M16 | present | absent | ok | — | — | none | downgrade to a pre-change binary | ? | ? | ? | ? |

Open decisions the reading must settle, with the options (the Lead records
the choice before code):

- **OD-M9/M10 (failure rollback):** while the map row still exists and the
  migration did not commit, does the legacy map keep delivering? (a) yes, as
  a source between seed and store — no delivered value is lost; (b) no — the
  map is never a source again. The umbrella text implies (b), but that loses
  values when the migration fails.
- **OD-M15 (cleared-name reimport):** on a filesystem that never confirms
  durability, can a name the operator cleared be re-imported? (a) accept and
  document it; (b) keep a names-only "imported" record so no re-import; (c)
  refuse the migration on such filesystems, with a listed reason.
- **OD-M16 (downgrade):** the documented rollback path is restoring the
  pre-upgrade database backup, which holds the map. Confirm, or ship an
  export.

