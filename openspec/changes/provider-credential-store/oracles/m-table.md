# Table M — A1 inputs with the bound outputs

Task 1.1 of `provider-credential-store`. Commit A1 (2de5c710) held the
design's table M with every output `?`; the outputs below are the bound
resolution (decision-0c2937c6), with A1's inputs unchanged. The
cross-family advisor fills the outputs from this change's spec scenarios
(`specs/provider-credentials/spec.md`, requirement "Legacy Settings
credentials migrate to the store at upgrade", and the store requirement's
"Applied and durable report separately") and the umbrella text quoted in
`design.md`'s appendix (D1 "Upgrade migration", crash table, D12-2/6) alone,
without the author's reading. The author's outputs were sealed as A2
(6964e921); the two were diffed and each disagreement is resolved below.

Axes: stamp (absent / present) × map row (absent / empty / non-empty) ×
store before (missing / ok / unreadable-unsafe-malformed) × per-entry
relation (name absent in store / same value / different value / name
registered) × store write outcome (durable / applied-not-durable / refused)
× crash point (none / before store write / after store write, before the
SQLite transaction / after the transaction) × mode (normal start / restored
pre-upgrade backup / downgrade to a pre-change binary).

| Id | Stamp | Map | Store before | Entry relation | Write outcome | Crash point | Mode | Store after | Map/stamp after | Listing shows | Delivery meanwhile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | present | absent | * | — | — | none | normal | Prior state stands | Map absent, existing stamp stands | Normal, complete, with stamp's skip names | Normal |
| M2 | present | non-empty | * | * | — | none | normal | Prior state stands | Residual map and existing stamp stand, no migration writes | Normal, complete, fixed diagnostic with ignored valid names | Normal |
| M3 | absent | absent or empty | * | — | — | none | normal | Prior state stands, missing remains missing | Absent or empty map left as found, no stamp or migration writes | Normal, nothing to migrate | Normal |
| M4 | absent | non-empty | missing or ok | name absent | durable | none | normal | Eligible absent entry added durably as launch-env, preserving name and value | Delete map and set stamp atomically | Normal, new store entry and complete | Normal using new entry at next eligible launch |
| M5 | absent | non-empty | ok | same value | durable | none | normal | Identical entry absorbed, including its existing kind, with durability confirmed | Delete map and set stamp atomically | Normal, complete, no skip for equality | Normal using existing entry |
| M6 | absent | non-empty | ok | different value | durable | none | normal | Existing different-valued entry wins with durability confirmed | Delete map and set stamp with its skip name atomically | Normal, complete, names-only collision skip | Normal using the winner |
| M7 | absent | non-empty | missing or ok | name registered | durable | none | normal | Registered name added as inert launch-env if absent, otherwise existing entry wins with the M5/M6 rule | Delete map and set stamp atomically | Normal, mark registered launch-env collision, names-only skip if different prior value wins | Registered name withheld, required composition refuses before spawning |
| M8 | absent | non-empty | missing or ok | * | applied-not-durable | none | normal | Applied rename stands without confirmed durability | Original map retained, stamp absent, next startup reattempts | Normal from readable applied store, pending with fixed unconfirmed-durability reason and observed skip names | Normal from current usable sources |
| M9 | absent | non-empty | missing or ok | * | refused (write-failed) | none | normal | Prior file bytes or absence stand after refusal | Original map retained, stamp absent, next startup reattempts | Normal plus fixed write-failure pending reason | Normal from prior usable sources |
| M10 | absent | non-empty | unreadable-unsafe-malformed | * | — | none | normal | Prior unusable store stands without repair or salvage | Original map retained, stamp absent, next startup reattempts | Fixed safe store reason plus migration pending | Process and seed under the normal filters |
| M11 | absent | non-empty | * | * | * | before store write | normal | Prior store remains at interruption | Map retained, stamp absent. Restart follows the applicable import outcome from that state | Service unavailable while stopped. After restart use that outcome's listing | Service unavailable while stopped. After restart use that outcome's projection |
| M12 | absent | non-empty | ok | * | durable | after store write, before transaction | normal | Durably moved entries stand. On restart absorb equal entries and preserve any different winners | Map retained and stamp absent at interruption. Successful retry deletes and stamps together. Failed retry follows M8–M10 | Service unavailable while stopped. After restart show actual outcome and collision skips | Service unavailable while stopped. After restart use normal projection |
| M13 | present | absent | ok | — | — | after transaction | normal | Durable store stands through restart | Map absent, stamp present, no migration writes on restart | Service unavailable while stopped. On restart normal and complete with stamped skips | Service unavailable while stopped. Normal on restart |
| M14 | absent | non-empty | ok (later entries) | same or different | durable | none | restored pre-upgrade backup | Restored map merges per name. Keep later store entries and import any eligible missing name | Delete restored map and set stamp atomically after confirmed durability | Normal, complete with differing-value skips | Normal, later store entries win |
| M15 | absent | non-empty | ok, operator cleared a migrated name while M8 repeated | name absent | durable | none | normal | Eligible cleared name reimported durably from retained map | Delete map and set stamp atomically in this durable row | Normal and complete with reimported entry. If confirmation fails again, M8 reports pending | Normal, eligible reimported entry can deliver |
| M16 | present | absent | ok | — | — | none | downgrade to a pre-change binary | External store remains in place across binary downgrade | Map absent and stamp ignored on the post-upgrade database. Restoring the pre-upgrade backup supplies its old map | Legacy surface reports environment or none before restore, with legacy settings source when backup supplies the map | Legacy launch reads process and seed before restore and uses its configured legacy map after restore, with that binary's filters |

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

**Binding (task 1.1, decision-0c2937c6, Lead note-41b235b1).** The outputs
above are bound; the inputs are A1's (2de5c710), unchanged. The independent
reading (Codex Sol, advisory task-66ea3109) and the author's sealed A2
(6964e921) were compared row by row and resolved as follows.

- **OD-M9/M10 = (b).** The map stays intact for recovery on a failed or
  unconfirmed import, but it is never a composition source: runtime
  resolution stays process env < seed < usable store (S3, C10). A map-only
  credential can be unavailable until repair and a successful retry; the
  pending state and its fixed reason are visible. The map reader serves the
  migration and names-only diagnostics only. (The author's (a) would add a
  fourth effective source on the auth, launch, availability, and pull paths,
  and contradict the published A1's Codex projection.)
- **OD-M15 = (a).** A later startup can reimport a cleared name while the
  old map survives; the pending status and the reimport risk are shown and
  documented. A durable retry commits the deletion and stamp; a repeated
  unconfirmed attempt is M8 with the map retained.
- **OD-M16 = restore the pre-upgrade database backup** when rolling back the
  binary; no export.

Output legend. *Normal* = the existing value-free listing and the published
projections, including all registered-name withholding and required-
composition refusals. An unusable store reads as absent (process and seed,
C10) with its fixed reason. Codex uses the published filtered process
projection in every current-binary row. Listing statuses and skip/ignored
records carry validated names and fixed safe text. File durability precedes
the single map-deletion-and-stamp transaction for a non-empty valid import,
even when every entry was absorbed or skipped. Same-valued entries keep their
kind and value without a skip; different-valued entries keep the existing
kind and value and record a names-only skip on the stamp — on first start
and on retry.

Decision rules. Apply the mode and crash boundary first, then the stamp and
map eligibility, then the store read/write outcome. M15 is the cleared-name
successful retry. In ordinary durable cases M7 takes priority over M4–M6 for
a registered name. A restored backup uses the same failure rules when a
retry cannot confirm durability. A stopped server has no listing or launch.
PM1's paired map/stamp outcome covers attempts from a valid non-empty
unstamped map; M2 (map beside a stamp) and M3 (no work) are covered
explicitly. PM2 requires zero file or settings writes on restarts after
quiescence.

Disputed rows (author A2 → bound): OD-M9/M10 (a → b), so M8–M10 deliver
from process < seed < store, not with the map as a source; M3 (A2 deleted an
empty row and stamped → left as found, no stamp, no write); M15 (A2 kept the
map while never durable → this row is the durable retry and commits); M16
(A2 "old binary shows seed only" → the legacy surface shows the legacy
source once the restored backup supplies the map).

