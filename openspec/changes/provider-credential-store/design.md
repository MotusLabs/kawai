# Design

## Context

This slice takes `provider-relay-setup` tasks 2.1–2.6 from a dormant core to
production. The umbrella's D1, D5, table W, P1 and P2 are the design basis.
They are copied verbatim into the appendix, and the sections below decide
what they mean on the current tree. Where the appendix says `KAWAI_CHAT_ENV`,
read `AGENTBOARD_CHAT_ENV` until `rename-agentboard-to-kawai` lands its group 1.
Where it mentions templates, retained defaults, install modes, header
variables, or the source listing, those belong to the held lineage,
`relay-headers`, or `relay-setup-flow` (source partition below).

Source pin: `f52963d0ab20d5ff9693fcd941e3c3f17970aa26`.

## Current inventory at f52963d0

- **Dormant core (landed #354, task 2.1).** `src/server/chat/credentialStore.ts`
  (471 lines): `CredentialStore` with `set` (:291), `clear` (:315),
  `reclassify` (:342), `status` (:412), `resolve` (:421), `list` (:429);
  `createCredentialStore(path, {retainSecretNames, deps})` (:463);
  `defaultCredentialStorePath()` (:458) uses `os.homedir()`.
  `credentialStoreDocument.ts` (131) holds the document grammar and
  `credentialStoreErrors.ts` (30) the errors. **No production importer**: only
  the module's own files and `src/server/__tests__/credentialStore*.test.ts`
  import it. Its `retainSecretNames` collaborator is optional in the type
  (:112) and refuses secret-source mutations when absent.
- **Settings map (to retire).** `src/server/routes/chatProviderEnv.ts` (130):
  `CHAT_PROVIDER_ENV_KEY = 'chat_provider_env'` (:19); `current()` returns
  override-or-seed **wholesale** (:41); GET redacts only `isSecretEnvName`
  names (:45-58); PUT persists values with `db.setAppSetting`. Bootstrap
  builds it at `src/server/bootstrap.ts:89`, passes `getProviderEnv:
  chatProviderEnv.current` (:184) and mounts `/api/settings/chat-provider-env`
  (:422).
- **Composition today.** `src/server/chat/chatProviderEnv.ts` (112):
  `parseChatProviderEnv` reads `AGENTBOARD_CHAT_ENV` (:53-70);
  `effectiveChatEnv` = `{...process.env, ...providerEnv}` (:74);
  `withheldCredentialNames` (:98). Consumers: `ClaudeProfiles.ts:134`
  (`serverEnv = effectiveChatEnv(globalEnv)`), `chatAuth.ts:34` (creation
  gate), `ChatSessionManager.ts:3090-3091` (`providerEnv()` from
  `getProviderEnv`), `:1118` (global base URL), `:2985` (Codex), `:3051-3067`
  (availability probe), `:3225` (`claimProviderUsagePull`).
- **Registry.** `secretNameRegistry.ts` takes `secretSourceKeys` as an
  explicit source that is empty in production (:28); `catalogRegisteredNames`
  (:132) feeds only catalog and retained names.
- **Client.** `src/client/components/ChatProviderSettings.tsx` (the Settings
  env editor) inside `SettingsModal.tsx:13,142`; tests
  `src/client/__tests__/chatProviderSettings.test.tsx`, `settingsModal.test.tsx`.
- **Wire contract.** `src/shared/chatProviderSettings.ts` (`ChatProviderEnvSource`
  :5, `ChatProviderEnvResponse` :7, `ChatProviderEnvUpdate` :16) is the typed
  contract shared by `routes/chatProviderEnv.ts` and `ChatProviderSettings.tsx`.
  Replacing that API (S5, table U) replaces this contract: the credential
  listing, set, clear, and reclassify bodies and outcomes go in a shared
  `src/shared/credentials.ts` (proposed), and the retired types are removed.
- **Recovery.** `docs/recovery-matrix.md` has no credential row.
- **Path mismatch (found now).** The catalogs resolve HOME first
  (`profileCatalog.ts:231`: `ctx.homeDir ?? process.env.HOME ?? os.homedir()`);
  the store's default path uses `os.homedir()` only. Decision S2 below.

## Source partition (this slice's rows)

| Source item | Disposition |
| --- | --- |
| task 2.1 store core | landed #354, dormant; group 1 maps its evidence; no rewrite |
| task 2.2 migration | group 3 |
| task 2.3 per-variable composition | group 2 |
| task 2.4 write-only read surfaces + Settings UI | group 4 |
| task 2.5 P1 store-path secrecy property | group 4 |
| task 2.6 docs | group 5 |
| requirement "Imported credentials live in the server-owned store" (12 scenarios) | here; "listing" reads as the credential listing (S4) |
| requirement "The credential UI is write-only" (3) | here |
| requirement "Credential resolution composes per variable" (5) | here |
| requirement "Legacy Settings credentials migrate to the store at upgrade" (4) | here |
| requirement "Store changes apply at the next launch" (2) | here |
| scenario "Reclassification does not end withholding" | here (MODIFIED "Registered secret names stay withheld") |
| MODIFIED "Named profiles configure independent provider sessions" (8 main scenarios + "A seed-only sibling key survives") | here, re-derived on current main (`AGENTBOARD_CHAT_ENV` text) |
| scenario "A migration skip is listed" (provider-setup) | `relay-setup-flow`; this slice records skips (names only) and shows them in the credential listing |
| D12 obligations 2 and 6 | groups 1 and 3 |

## Decisions

**S1 — Keep the core; wire, do not rewrite.** The landed API and its tests
are the store. The production factory makes `retainSecretNames` mandatory.
Construction without it is a bootstrap error, never a silent no-op. The
collaborator is the SQLite registry (`observeRegisteredNames`), and every
secret-source mutation persists the name before the file changes (core
order, already tested at the seam).

**S2 — One path rule.** Production resolves the store at
`<HOME>/.kawai/credentials.json` with the same HOME precedence the catalogs
use (`process.env.HOME`, else `os.homedir()`), so the catalogs and the store
never split across two homes. The core's `defaultCredentialStorePath()`
changes to that rule, or the factory passes the path explicitly; either way
a planned test asserts the two paths agree under an overridden HOME.

**S3 — One composition, two projections.** A new owner (proposed
`src/server/chat/credentialComposition.ts`) computes, per variable,
*resolution* = process env < seed < store (any kind; blank exports empty;
absent passes through) and *delivery* = resolution minus registered names,
with launch-env store entries delivered unchanged. It replaces
`routes/chatProviderEnv.ts`'s `current()`, which bootstrap stops passing.
Every consumer above takes one of the two projections, never the raw map:
the gate, injection, availability probe and usage pulls read resolution;
Claude and Codex launches read delivery. The registry's `secretSourceKeys`
source is fed from the store listing at every observation.

**S4 — "The listing" is the credential listing.** The store requirement's
"listing" means the Settings credential listing this slice adds (name, kind,
state, source, overriding mark, collision mark, migration skips, store
status). `relay-setup-flow`'s configuration-source listing later embeds the
same projection, so it adds no second reader.

**S5 — Settings API replaced, not extended.** `GET /api/settings/credentials`
returns metadata only (P2). Mutations are `PUT` (set/replace with a value),
`DELETE` (clear), and `POST …/reclassify` (kind change). Each returns the
typed outcome (`applied`, `durable`) and fixed safe text. The old
`/api/settings/chat-provider-env` GET and PUT are removed in the same change.
The WS router whitelist does not change, because these are HTTP routes.

**S6 — Migration is a startup step, not a numbered SQL migration.** It runs
in bootstrap after `initDatabase` (so after the startup backup and SQL
migrations), before the chat routes serve and before any session spawns.
It writes the store file first, then, after a durable acknowledgement only,
commits the map deletion and the stamp `credential_store_migration` in one
SQLite transaction. It goes through the core's single per-file owner, so
there is no second write path. Its failure and recovery outcomes are the M
table below, which gets the blind reading before code.

## Acceptance oracles

### Composition table C (per variable; observable at gate and launch)

`*` = don't care. "Registered" = in the registry union (catalog, store
secret-source key, retained).

| Id | Process env | Seed | Store entry | Registered | Resolution (gate, injection, pulls) | Delivery (launch) |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | set | absent | absent | no | process value | process value |
| C2 | * | set | absent | no | seed value | seed value |
| C3 | * | * | launch-env set | no | store value | store value (W6) |
| C4 | * | * | launch-env blank | no | empty string | empty string |
| C5 | * | * | secret-source set | yes (by construction) | store value | absent under its own name; reaches a launch only through a binding (W3) |
| C6 | * | * | launch-env set | yes | store value | absent (W7, inert) — the credential listing marks the collision |
| C7 | set | absent | absent | yes | process value | absent (W2/W5) |
| C8 | absent | absent | absent | * | absent | absent |
| C9 | * | set (two variables) | launch-env for one of them | no | per variable | per variable: store for one, seed for the other ("A seed-only sibling key survives") |
| C10 | * | * | store unreadable / unsafe / malformed | * | composes process env < seed, as if the store were absent; listing reports the fixed reason | same, minus registered names |

Unreachable: a secret-source store entry whose name is not registered — the
store's secret-source names are a registry source (S3), so C5 always has
"yes".

### Write-only read surface table U

| Id | Request | Observable response |
| --- | --- | --- |
| U1 | GET listing, any store contents | per name: kind, state (set/blank), source, overriding/collision marks; no value, prefix, or length |
| U2 | PUT set with value | typed outcome; the value never appears in the response or any log |
| U3 | PUT with NUL in value, invalid name, or secret-source name outside the catalog pattern | fixed reason, prior bytes stand, no registry call for an invalid name |
| U4 | DELETE absent name | `{applied:false, durable:false}`, nothing created |
| U5 | any mutation on a malformed/unsafe store | fixed reason; prior bytes stand |
| U6 | applied but not durable | outcome reports applied-not-durable; UI shows the warning; no retry |
| U7 | old `/api/settings/chat-provider-env` | 404 (retired) |

### Migration table M (state machine with recovery) — inputs only, for the blind reading

Per `docs/agent-collaboration.md` ("Write acceptance as oracles"), this
table's **outputs are deliberately `?`** in this planning package. Group 1
commits it unchanged as A1. An advisor from another model family fills it
from the spec scenarios alone, the author's reading is committed as A2, and
the Lead records the resolved table as binding before any group-3 code. The
binding properties below already constrain every output.

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

### Properties

- **PM1 — No value is lost or duplicated into SQLite.** For a seeded
  sequence of (map contents, store pre-contents, write fault at each step,
  crash at each transaction boundary, restart until quiescent): every map
  entry ends either in the store with its map value, or listed as a skip
  where the store held a different value. The map row is absent iff the
  stamp is present. No SQLite row written by the migration contains a
  value. Generator: seeded records of names from both name patterns,
  values with unshaped sentinels; seams: the core's `deps` fault seam, a
  SQLite transaction-abort seam, a restart harness. Fixed seed, 300 cases
  (`propertyCases`), no new dependency.
- **PM2 — Idempotent restarts.** Any number of restarts after quiescence
  changes no byte of the store and no `app_settings` row. Same generator,
  100 cases.
- **PC1 — Composition equals the table.** For seeded (process env, seed,
  store, registry) tuples, the gate's resolution and each launch branch's
  delivered env equal table C's projection. The launch is checked by the
  composed structure the real `resolveClaudeProfile`/`codexSpawnEnv`
  produce, never a re-implementation. 200 cases.
- **P1s — Store secrecy (umbrella P1, store paths).** No store value in any
  HTTP body, log line, wire-log frame, SQLite row, or flag settings layer,
  including the migration write and the editor's failure log path. 200
  cases, fixed seed (task 2.5).
- **P2 — Write-only (umbrella P2).** Random import/replace/blank/clear/
  reclassify sequences: every read surface returns name, kind, state,
  source only. 200 cases.

### Production-composition oracles (one per guarded seam; each kills a wiring mutant)

| Id | Real path exercised | Observable | Mutant it must kill |
| --- | --- | --- | --- |
| PW1 | bootstrap → credential routes → store file | `PUT` then `GET` through the mounted Hono app writes `credentials.json` 0600 and lists metadata | bootstrap mounts the old provider-env routes |
| PW2 | store → composition → `ChatSessionManager` creation gate (`chatAuth`) | a token resolving only through the store passes creation and the spawned launch carries it inside `ANTHROPIC_AUTH_TOKEN` ("Gate and spawn agree through the store") | gate reads `effectiveChatEnv(seed)` |
| PW3 | store secret-source key → registry → Codex and Claude launches | the key is absent from both launches under its own name | registry built without `secretSourceKeys` |
| PW4 | bootstrap migration on a disposable DB copy with a seeded map | after start: store holds the entries, map row gone, stamp set; second start writes nothing | migration deletes the map before the durable acknowledgement |
| PW5 | `claimProviderUsagePull` | a provider pull reads a store-only balance key | pull reads the raw seed |

### Scenario coverage plan

"Current" cites landed core tests (seam evidence for the dormant core, task
2.1). "Planned" names this change's task, where production-path evidence is
added. Every scenario has both where the core already covers it.

| Scenario | Current evidence (`file` › `title`) | Planned |
| --- | --- | --- |
| Import writes only the store | — | 4.1 (PW1), 4.4 (P1s) |
| Corrupt store degrades visibly | `src/server/__tests__/credentialStore.test.ts` › `a 0000 file is unreadable and mutations refuse` | 2.6 (C10 at the gate and launch, listing) |
| Invalid store is never salvaged | `src/server/__tests__/credentialStore.test.ts` › `NUL value, NUL secret value, invalid kind, invalid value type` | 2.6 (C10) |
| Legacy launch-env names are preserved | `src/server/__tests__/credentialStore.test.ts` › `set, blank, unset, value-free listing, mixed-case name preserved on disk`; `src/server/__tests__/credentialStoreAdmissionEquivalence.test.ts` › `a 33-entry document round-trips with disjoint preservation` | 3.1 (migration of a mixed-case map entry) |
| Secret sources require catalog-compatible names | `src/server/__tests__/credentialStoreAdmissionEquivalence.test.ts` › `secret-source admission matches the catalog binding boundary` | 4.1 (U3) |
| NUL never enters or persists in the store | `src/server/__tests__/credentialStore.test.ts` › `NUL value, NUL secret value, invalid kind, invalid value type` | 4.1 (U3) |
| Unsafe permissions refuse every access | `src/server/__tests__/credentialStore.test.ts` › `0644 refuses read and mutation, never chmodded, bytes stand`; `src/server/__tests__/credentialStore.test.ts` › `0400 reads, and an explicit set replaces it atomically with a fresh 0600` | 2.6 (C10) |
| Gates precede any cached value | `src/server/__tests__/credentialStore.test.ts` › `a warmed cache never serves past a symlink or unsafe mode; edits reload`; `src/server/__tests__/credentialStoreTrustGates.test.ts` › `a warmed cache never serves past a foreign owner` | — |
| Applied and durable report separately | `src/server/__tests__/credentialStoreDurability.test.ts` › `an exact store-directory fsync fault reports applied but not durable` | 4.1 (U6), 3.1 (M8) |
| Secret-source changes retain the name first | `src/server/__tests__/credentialStore.test.ts` › `retain runs before the credential file changes`; `src/server/__tests__/credentialStore.test.ts` › `missing collaborator refuses before any file change` | 2.1 (real SQLite collaborator), 2.5 |
| A change that changes nothing writes nothing | `src/server/__tests__/credentialStoreMutations.test.ts` › `clearing an absent entry is a no-op that leaves the file untouched`; `src/server/__tests__/credentialStoreReclassify.test.ts` › `valid no-ops return false/false and never touch bytes or the registry` | 4.1 (U4) |
| Blank is a stored state for both kinds | `src/server/__tests__/credentialStore.test.ts` › `set, blank, unset, value-free listing, mixed-case name preserved on disk` | 2.2 (C4) |
| The credential UI is write-only (3 scenarios) | — | 4.1, 4.2, 4.3 |
| Credential resolution composes per variable (5 scenarios) | — | 2.2, 2.3 |
| Legacy Settings credentials migrate to the store at upgrade (4 scenarios) | — | 3.1, 3.2, 3.3, 5.1 |
| Import then create; Running session keeps its environment | — | 4.5 |
| Registered secret names stay withheld: the four scenarios carried from `provider-relay-secret-registry` | that change's scenario map (unchanged tests) | 2.5 re-runs them with the store source wired |
| Reclassification does not end withholding | `src/server/__tests__/registeredNamesRetention.test.ts` › `every remove/disable/clear/reclassify sequence keeps registered names withheld` (seam only) | 2.5 (real collaborator) |
| Named profiles: the eight scenarios unchanged from main | existing named-profile launch tests (task 1.2 records their literal titles) | 2.4 (re-run unchanged) |
| Named profiles: A seed-only sibling key survives | — | 2.2, 2.4 |

## Implementation contract

### Acceptance
- A1: In the composed server, every row of table C holds at the creation gate and at Claude and Codex launches, shown by PC1 and by PW2/PW3 through `ChatSessionManager` with each row's observable delivered or absent variable.
- A2: `GET /api/settings/credentials` and every other read surface return name, kind, state, source, and marks only for any store contents (U1, P2); the retired `/api/settings/chat-provider-env` answers 404 (U7); mutations return the typed applied/durable outcome with fixed safe text (U2-U6).
- A3: The startup migration behaves as the binding M table (after the blind reading) for every row, and PM1/PM2 hold; PW4 shows it on a disposable database copy through the real bootstrap.
- A4: A secret-source store key is absent from every launch under its own name and stays withheld after reclassification to launch-env while registered ("Reclassification does not end withholding"), through the real registry collaborator (PW3).
- A5: The store path and the catalog directory resolve under the same HOME (S2), asserted with an overridden HOME.
- A6: `docs/recovery-matrix.md` gains a row for the credential migration naming its mechanism, this change, the M rows, and a passing test title; `docs/claude-session-profiles.md` documents the store, kinds, migration, and backup honesty, and the AGENTS.md profiles bullet names the store.

### Invariants
- I1: No credential value is written to SQLite, a log line, a wire-log frame, a client payload, or the flag settings layer by any path this change adds or touches (P1s).
- I2: The migration never deletes the Settings map row before the store write reports durable, and never runs a second write path beside the core's per-file owner.
- I3: Every launch receives an explicitly filtered environment; no registered name reaches a launch under its own name (registry rows R-W1..R-RF keep passing).
- I4: No live install, live database, or live `~/.kawai` is read or written by tests or rehearsals; all use disposable HOME and database copies.
- I5: `openspec/changes/provider-relay-setup/**` stays byte-identical; no held task changes.

### Scope
- `openspec/changes/provider-credential-store/**`
- `src/server/chat/credentialStore.ts`
- `src/server/chat/credentialComposition.ts`
- `src/server/chat/credentialMigration.ts`
- `src/server/chat/chatProviderEnv.ts`
- `src/server/chat/secretNameRegistry.ts`
- `src/server/chat/ClaudeProfiles.ts`
- `src/server/chat/codexProfiles.ts`
- `src/server/chat/chatAuth.ts`
- `src/server/chat/ChatSessionManager.ts`
- `src/server/routes/chatProviderEnv.ts`
- `src/server/routes/credentials.ts`
- `src/shared/chatProviderSettings.ts`
- `src/shared/credentials.ts`
- `src/server/bootstrap.ts`
- `src/client/components/ChatProviderSettings.tsx`
- `src/client/components/settings/**`
- `src/client/components/SettingsModal.tsx`
- `src/client/__tests__/chatProviderSettings.test.tsx`
- `src/client/__tests__/settingsModal.test.tsx`
- `src/server/__tests__/credential*.test.ts`
- `src/server/__tests__/registeredNames*.test.ts`
- `src/server/__tests__/chatProviderEnv*.test.ts`
- `docs/recovery-matrix.md`
- `docs/claude-session-profiles.md`
- `docs/architecture/**`
- `AGENTS.md`
- `openspec/specs/provider-credentials/spec.md`
- `openspec/specs/claude-session-profiles/spec.md`

### Verification
- V1: Table C, U, and the binding M table are committed verbatim as table-driven tests next to the code; PM1, PM2, PC1, P1s, P2 run as seeded properties through `propertyCases`.
- V2: PW1-PW5 run through the production composition, and each named wiring mutant fails its test; the result lists each mutant with its failing title.
- V3: Preserved workflows still pass: `src/server/__tests__/credentialStore*.test.ts`, the registry tests, the chat provider settings client tests (rewritten only where the retired GET is asserted), and the existing auth-gate and launch tests.
- V4: The literal-citation preflight finds zero unresolved citations; the clean committed head passes `bun run check --full-properties` (pinned Bun 1.4.3); `bun scripts/verify-result.ts` exits 0.
- V5: A disposable-copy rehearsal — a copied database with a seeded map, a disposable HOME, a spare port, never the live data directory — records the PW4 outcome; e2e, if any, runs only through the CI fixture path.

### Excluded
- X1: Header bindings and their registry source (`relay-headers`).
- X2: The configuration-source listing, preview, connection test, diagnostics, and model availability (`relay-setup-flow`).
- X3: Install modes, merge semantics, `enabled: false`, shipped trim, templates, retained-defaults layer (held lineage task-c6bfbd04).
- X4: Running the migration on the operator's live install, or any service restart; that is the owner's upgrade decision.
- X5: Renaming `AGENTBOARD_CHAT_ENV` (`rename-agentboard-to-kawai` group 1).

## Execution checkpoints

1. **Oracle checkpoint (before any code).** Commit A1 (the M table above,
   outputs `?`). A cross-family advisor fills it from the spec alone. Commit
   A2 with the author's outputs, then diff and resolve the two in the table,
   including OD-M9/M10, OD-M15 and OD-M16. The Lead records the binding
   table in the task journal.
2. **Design challenge.** Per the collaboration doc, before substantial code:
   the invariant/ownership/production-path/failure/evidence note for S3/S6.
   This is one advisory round.
3. **First production path.** PW2, one store-only token through the real
   gate and launch, plus one failure path (C10, a malformed store composing
   the lower sources). Show it before expanding to every consumer.
4. **Migration path.** PW4 on a disposable copy plus PM1, then the
   recovery-matrix row.
5. **UI and secrecy.** U table, P2, P1s, and the client editor.
6. **Final.** Docs, citation preflight, full-properties certificate, one
   complete result.

## Dependencies and serialization

- **Correctness prerequisite:** none beyond master (core #354 and registry
  #325 are landed).
- **Archive order:** after `provider-relay-secret-registry` (MODIFIED target).
- **Shared requirement "Named profiles configure independent provider
  sessions":** also modified by `mimo-million-token-context` and
  `rename-agentboard-to-kawai`. The order is serialization only: whichever
  archives later re-derives its block from main. Recommended order: mimo
  (smaller) first, then this, then rename.
- **Shared files:** `ClaudeProfiles.ts` and `ChatSessionManager.ts` with
  mimo, codex-capacity-retry, process-observability's quota slice, and
  rename's group 1 (env helper). Use one writer at a time; no rename-first
  hard edge.
- **Downstream:** `relay-headers` and `relay-setup-flow` need this slice's
  composition and listing (hard edges).
- **Rename:** after this lands, rename's group 1 renames the seed variable
  in this slice's composition module too.

## Risks

- The data move is the riskiest step: the oracle checkpoint and the
  disposable-copy rehearsal come before any live upgrade, and the live
  upgrade is the owner's.
- `routes/chatProviderEnv.ts` callers outside bootstrap may assert the old
  GET; group 4 inventories them before deleting.
- OS-level same-user readers can still read the 0600 file (appendix,
  "Threat boundary"); this slice claims no more.

## Appendix — inherited text (verbatim from `provider-relay-setup/design.md` at f52963d0)

Copied unchanged for implementer context; the sections above decide scope.

### D1 (lines 47-305)

**Choice.** Imported credential values live in `~/.kawai/credentials.json`
(`HOME`-resolved like the catalogs): a versioned document
`{"version": 1, "entries": {NAME: {"kind": "secret-source" | "launch-env",
"value": string}}}`, one entry per variable. The value is a non-empty string
(**set**), an empty string (**blank** — the variable is exported empty at
launch, overriding lower sources, like a catalog env blank today; blank is
valid for both kinds and never reads as unset), or the entry is absent
(**unset** — lower sources show through; the UI's Clear removes the entry).
Names are admitted per kind. A store NAME — so every migrated legacy
Settings entry — keeps the legacy Settings name shape
`^[A-Za-z_][A-Za-z0-9_]*$`: mixed case is valid, and legacy and seed
names (`http_proxy` and its kind) are stored and delivered unchanged,
never case-converted, renamed, or dropped. A `secret-source` entry
additionally requires the catalog binding pattern `^[A-Z_][A-Z0-9_]*$`;
reclassifying a launch-env entry whose name fails that pattern to a
secret source refuses with a fixed reason before any file change or
retained-name collaborator call — never silently uppercased. The store
keeps local copies of both patterns with separated equivalence tests
(the secret-source rule against the catalog pattern; the store-wide rule
against the legacy `chatProviderEnv` validator — the module-private
regex is not exported, and no shared source changes here). Values
persist byte-for-byte, without coercion, and the store invents no new
admission cap: no entry count, no value-length bound (no 32-entry or
4096-character cap) — the legacy Settings validator's limits stand
unchanged at the legacy input boundary, and the §2.2 migration imports
every valid legacy entry even into a store already holding additional
disjoint entries. A set or replace carrying a NUL character in the value
refuses with a fixed reason before any side effect, for both kinds, and
a reclassification refuses when its supplied or current candidate value
carries one. An unsupported `version`, an unknown `kind`, an invalid
name or entry shape for its kind, or a stored value carrying NUL is
**malformed** — reported and refused, never salvaged into a default
(below).
The module (`src/server/chat/credentialStore.ts`) creates the file with mode
0600, never widens permissions on an existing file, refuses symlinks, writes
atomically (temp file `O_EXCL|O_NOFOLLOW` 0600 plus explicit fchmod, in the
same directory, fsync, rename), and caches by an mtime/size stamp
(`profileCatalogStamp`'s pattern) so per-launch reads stay cheap.

**One owner per file; gates before cache.** One module-owned coordination
owner per resolved file holds the parse cache AND the whole read-modify-write
queue — every instance, every mutation (`set`, `clear`, `reclassify`), and
the later §2.2 migration (no independent migration write path). The owner is
keyed by the stable validated real parent identity (the resolved parent's
device + inode plus the file name; the canonical path is retained), so
stable parent symlink aliases converge on one owner; an implementation that
can key only by canonical realpath must bound out bind aliases and return
for disposition before claiming the all-in-process guarantee. Outside the
guarantee, stated: external processes, aliases or parents that change after
resolution, and same-user hostile tools. A mutation acquires the shared
queue first and reads the latest bytes only after acquiring it. **Every
access — a cache hit included — passes the security gates first**: `lstat`
shows a regular non-symlink file owned by the effective uid with zero
group/other mode bits; the read opens `O_NOFOLLOW` and its `fstat` identity
matches the observed `lstat`; a failed gate never follows the target. Only
behind the gates does the mtime/size stamp decide cache reuse (the absent
state caches too). The stamp stays a cache heuristic, not a freshness proof:
a same-mtime/size external content change is a stated limitation, and
passing the gates certifies nothing about content.

**Permissions.** A created store is owner read/write 0600 and is never
widened. An existing file carrying any group or other access bit (0644 and
alike) refuses reads and mutations, reported — never auto-chmodded; the
operator repairs it. A 0400 file reads; an explicit save may replace it
atomically with a fresh 0600 file, never chmod in place. A symlinked store
path is refused on every access; the parent `~/.kawai` may legitimately be
reached through a stable symlink (catalog-compatible HOME aliases are not
silently rejected). When the store creates a missing `~/.kawai`, it is
created 0700. Durability is never inferred from visibility: a chain that
merely predates the write — created by a prior failed process and visible
to this one — is still unconfirmed. Every renamed write confirms, in one
pass, the store directory's real chain and every real ancestor through the
filesystem root before any durable success is claimed. A path spelling that
resolves to the same real directory may open successfully even when a
component is replaced mid-write; the durable claim attaches to the chain
confirmed at confirmation time, and no detection of such replacements is
claimed. An operator-created symlink inside the chain is unconfirmed
exactly because the store itself creates directories only — never because
a symlink merely predates a write.

**Applied and durable are distinct outcomes.** The commit point is the
rename. A failure before the rename leaves the previous file byte-for-byte
untouched, removes the temp file, and refuses with `write-failed` — not
applied. After a successful rename, the store directory — resolved to its
real path — and every real ancestor through the filesystem root is fsynced;
the first required realpath, open, or fsync failure reports **applied, not
durable**: the new content is visible and stands, durability is
unconfirmed, no rollback or retry runs, and no ancestor is substituted for
a failed required one — the cache invalidates and verified-reloads. Callers
get the typed outcome, and both consumers act on it: the future Settings
warning surfaces the uncertainty, and the §2.2 migration deletes the
Settings map and commits its stamp only after a durable acknowledgement.
The blanket "a failed save leaves the previous file untouched" therefore
holds before the rename only. A valid clear or reclassification that changes
nothing — an absent entry over a missing or readable store, or a
reclassification to the entry's current kind — reports
`{applied:false, durable:false}`: no file, directory, or registry call;
`durable` is meaningful only when `applied` is true, and callers branch on
`applied` first.

**Corruption fails closed.** A missing file is an empty store; the first
save creates it 0600. An unreadable file, a failed trust gate, or a
malformed document is reported under one fixed safe reason in the source
listing; resolution then composes as if the store were absent — the process
environment and the `KAWAI_CHAT_ENV` seed still apply — and every mutation
refuses while the prior bytes stand. Clear is not a corruption reset; no
automatic backup, rename, or overwrite runs; v1 repair is manual, and the
listing says so.

**Fixed, value-free text.** Every error, outcome, and listing string is a
fixed safe text naming the path class and a reason code — never a
`JSON.parse` or fs message, never a cause chain, never a value, prefix, or
length; an invalid raw input is never echoed back as a name. Metadata reads
return name, kind, presence, and source only; the internal resolver consumes
values without exposing them.

**Threat boundary, stated
honestly:** mode 0600 protects against other users on the host — it is not
isolation from tools running as the same user, which can read the file.
What keeps values from agents is that no launch receives a **secret
source** except inside the two composed variables (D2); launch-env entries
are delivered unchanged — migrated legacy values included (table W's W6/W9,
the one stated exception to the composed-forms rule, possibly secret and
never called non-secret) — and no prompt, tool allowlist, or read API
exposes the store's contents or path semantics beyond presence and source.

**Two kinds of entries (L-B).** The store holds two kinds, both write-only
on every read surface (name, presence, source — never a value or prefix):

- **Secret sources** — values withheld from every launch under their own
  names (the registry, D2); they reach an agent only through a binding: a
  provider's `authTokenEnv`/`balanceKeyEnv`, or a `headers` binding.
- **Launch-env entries** — delivered to launches **unchanged**, exactly as
  the legacy Settings map is delivered today: composed per variable into
  the launch environment. A launch-env entry is not a withheld kind; the
  one thing that stops its delivery is a **registered name** (table W7/W8):
  a launch-env entry whose name a catalog binding, a secret source, or the
  retained-names set already registers stays inert, and the collision is
  reported — registration follows names, not kinds.

The migration imports every legacy Settings map entry as a **launch-env
entry**, so post-upgrade delivery is behavior-identical to today's; the
operator may reclassify an entry as a secret source in Settings. The
Settings env editor writes the store (launch-env by default; reclassification
is an explicit act). The old GET that served non-secret-named values
verbatim is gone.

**Retained names before secret-mutation success.** The store exposes one
required narrow collaborator for secret-source mutations: a `set`,
`clear`, or `reclassify` that changes an entry whose current or resulting
kind is secret-source persists the entry's NAME (never its value) into the
retained-names registry through the §2.3 registry owner **before** the store
reports success. The current kind comes from the store bytes read inside the
mutation queue (never the stamp cache); collaborator presence is checked
before any state read when the resulting kind is secret-source, and after
that read when only the current kind is. A missing or throwing
collaborator refuses the mutation before the credential file changes; the
core never defaults the collaborator to a silent no-op. Persisting the name
before the file write is the conservative order — a later file-write failure
leaves the name withheld with no stored value (over-withholding is safe).
The production factory wires the real SQLite registry (§2.3 caller work);
core tests use argument-checking memory collaborators, which prove the
refusal order only — not the real registry, launch withholding, or P7.

**Two compositions, stated apart.** *Resolution* — what the auth gate,
injection, and provider usage pulls read for a variable: process env <
`KAWAI_CHAT_ENV` seed (the `AGENTBOARD_CHAT_ENV` seed until
`rename-agentboard-to-kawai` archives; `routes/chatProviderEnv.ts:39–43`)
< store — any store entry wins, secret source or launch-env entry. *Delivery*
— what a launch receives: the same composition, minus every registered
secret name — a secret source never rides the launch env under its own
name; it reaches the CLI only inside a composed binding (`ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_CUSTOM_HEADERS`). Launch-env entries ride unchanged. The source
listing shows every source present per variable and warns on conflicts. The
old wholesale-replacement semantics (`current()` returning override-or-seed)
is retired with the override.

**Why not SQLite:** backups copy the database (`DatabaseBackups`); a
credential in a row lands in every snapshot and in `status()` listings —
as the Settings map already does today (the migration below states the
limits of that honestly). The store file sits beside the catalogs, which
backups never touch.

**Why not a project file:** `.kawai/` files are agent-writable; trust never
descends below the user level (existing rule, unchanged).

**Alternatives considered:** env-wins (store fills only missing variables) —
an import would silently do nothing while a stale container env var exists,
the exact debugging session this change ends; keyring/OS secret service — a
new host dependency kawai does not have today; keeping Settings as a source —
its values persist in SQLite and its read path redacts by name regex only
(`routes/chatProviderEnv.ts:45–56`), so a credential named
`RELAY_VALUE` is served verbatim; SQLite with backups excluded — fragile
against the backup path growing.

**UI.** Settings gains a credential section: per variable, set or replace
(masked input, never rendered back), blank (export empty), clear. Read
surfaces (the source listing, the preview) show name, presence
(set/blank/absent), and source — never the value or a prefix.

**Effect without restart.** Launch resolution reads the store per stamp, like
catalog files; a save applies at the next spawn. Active processes keep their
environment (unchanged rule for Settings and catalogs).

**Upgrade migration (L-B): file first, then SQLite.** At the first startup
after this change, when the Settings provider-env map (`app_settings`) is
non-empty: (1) each map entry is written once into the store file as a
launch-env entry — an entry whose name the registry already holds (a
catalog binding or a retained name) is imported **inert** per table W7,
the collision listed in the source listing naming the variable and the
supported credential setting — the store file is written durably (atomic
rename + fsync) **before** any SQLite write; (2) then — only after the store write reported **durable** — in one SQLite
transaction, the map row is deleted and the migration stamp is committed; an
applied-but-not-durable store write leaves the map in place and the
migration re-runs on the next start.
The stamp's presence never re-runs the migration. On a filesystem that
permanently refuses a required confirmation step (for example a directory
fsync on a special filesystem), every store write reports applied but not
durable forever — the map stays and the migration re-runs each start;
re-running re-imports the same values (absorbed when equal), but a name the
operator cleared from the store while the map stayed retained would be
re-imported. Resolving that repeated-reimport and cleared-name risk — a
reimport cap, an operator escape, or refusing migration on such
filesystems — is §2.2 implementation scope at its own later gate; the
store's contract does not change now.

**Crash, collision, and restart table** (each row is the state a restart
finds, and what it does):

| Crash point | Store file | `app_settings` | Restart behavior |
| --- | --- | --- | --- |
| before the store write | old | map present, no stamp | migration re-runs from the start; nothing was moved |
| after the store write, before the SQLite transaction | moved entries present | map present, no stamp | re-run: a map entry whose store name already holds the **same** value is absorbed silently (idempotent); a **different** value is a collision — the store entry wins, and the skip is recorded in the source listing as "legacy Settings `<NAME>` not migrated: the store already holds `<NAME>`"; then the map row is deleted and the stamp commits |
| after the SQLite transaction | moved entries present | map deleted, stamp set | never re-runs (stamp) |

The table's rows are crash points; the applied-but-not-durable outcome above
is not one of them — the SQLite step simply never runs on it. A restored
pre-upgrade backup (map present, no stamp) re-runs the migration
the same way; entries the later store already holds absorb or collide per
the middle row. All store readers and writers share the one per-file
coordination owner (above).

**Backup honesty.** Every backup taken **before** the migration's SQLite
commit may hold the old map values — including the upgrade's own startup
snapshot (`dbSafety` snapshots before application migrations run) and every
`pre-migration-<n>` backup. Nothing retroactively scrubs them.
`docs/claude-session-profiles.md` says so, advises rotating any pre-upgrade
credential whose presence in old backups matters, and states when rotation
ages them out (24 hourly `interval` snapshots ≈ a day, 7 `startup`
snapshots, migrations' own backups while the newest-three-migrations
rotation retains them). **No backup taken after the commit holds the map
values.** The store file itself is never copied by `DatabaseBackups`.
The source listing shows every source present per variable and warns when
more than one holds the same variable. The old wholesale-replacement
semantics (`current()` returning override-or-seed) is retired with the
override.


### From D5 (lines 596-640)

Every field resolves through one table; the setup surface renders it and
warns on conflicts (a nearer layer overriding a value set at a layer the
setup edits, when the two differ).

| Field | Far → near (winner last) | Notes |
| --- | --- | --- |
| Catalog entry fields — label, model, env (per key), executable, limitResetTimeZone, authTokenEnv, balanceKeyEnv, headers | shipped < user < project | per field and per env key; trust refusals (D3) apply before merge for credential-bearing ids |
| Catalog runtime keys — `runtime`, `codexHome`, `network` | **runtime-origin rules, not nearest-wins**: a nearer file cannot flip a runtime a farther tier fixed (`addCodexProfile` ignores the nearer entry with that file's error); `codexHome`/`network` arrive only from trusted files; the same-tier release rule applies | `catalogMerge.ts:451–479` |
| Credential values | process env < `KAWAI_CHAT_ENV` seed < credential store | per variable, the resolution order (D1); a launch receives the delivery composition minus the registry (the composition table below); Settings is no longer a source; conflicts warn naming the sources |
| Launch env | see the composition table below | pinning is existing behavior (openrouter-provider D3), extended to headers-only providers |
| Model ID sent | startup `model` option; else `ANTHROPIC_MODEL`; tier aliases resolved through `ANTHROPIC_DEFAULT_*_MODEL` | the wire ID is the post-alias string the CLI actually sends (D10); env keys compose `inherited < provider < model` (`flattenModel`) |

**Launch composition — one table, every branch (L-E, B1).** No branch
inherits the server process environment raw: every launch receives an
explicitly filtered environment — today's default resolve already does
(`ClaudeProfiles.ts:124–130, 153–155`) — and the withheld set on **every**
branch is the registered-name set of table W (D2's registry): catalog
binding names in any layer and state, secret-source store keys, retained
names. The controlled-variable deletions and transport pins are branch
operations the table applies below, not members of that set — a Default or
wrapper launch keeps an ambient base URL or proxy as at the base (W1).
Ambient credentials pass only when nothing registers their name. What each
branch receives:

| Branch | Environment the CLI process receives | Composed credentials in it | Notes |
| --- | --- | --- | --- |
| Claude, Default (no profile), no overrides | the filtered env: process env − withheld names, plus store launch-env entries as configured | none — host claude.ai login path (or an unregistered ambient `ANTHROPIC_AUTH_TOKEN`), unchanged | today's behavior: the resolve supplies an explicit env; routing or unrelated overrides an operator set ride the launch-env entries |
| Claude, named non-wrapper profile | the filtered env + launch-env entries + the profile's catalog env overlaid; every controlled variable the profile does not set **deleted**; absent catalog keys blanked in the flag settings layer | none unless the profile is credentialed (row below) | unrelated variables (operator overrides, launch-env entries) are retained, per today's named-profile rule |
| Claude, wrapper (`executable`) | the filtered env + launch-env entries + the wrapper's overlay env | none **composed** — a credential-bearing id can never take an executable (trusted invariant); an unregistered ambient token passes only by name, like Default | wrappers never gain tokens or headers through the catalog |
| Claude, credentialed or headers-only | the named-profile branch **plus** transport pins (base URL + `TRANSPORT_PIN_ENV`) in env and flag settings | `ANTHROPIC_AUTH_TOKEN` (credentialed) and composed `ANTHROPIC_CUSTOM_HEADERS` (headers) in env only | the token reaches the CLI exactly as today; headers-only has no token |
| Codex | the filtered env; `codexHome`/`network` from trusted tiers per the runtime-origin rules | none via Claude composition — credentials via the Codex login in its home | one workspace-write sandbox as today |

Direct legacy auth (an ambient `ANTHROPIC_AUTH_TOKEN` or the claude.ai
login in the server env) rides the filtered env on the Default branch
exactly as today; the filter removes it only once a catalog binding, a
secret-source store key, or a retained name registers that name
(W2–W5 — an unregistered launch-env entry delivers instead, W6), and the
source listing shows which source
wins (D1's resolution order).

Unreachable combination: a project file setting `authTokenEnv`,
`balanceKeyEnv`, `headers`, `enabled`, or `executable` never contributes —
the file is rejected whole (existing refusals, plus `enabled` and `headers`).

### Table W (lines 1033-1076)

One registered-name set, defined once (D2's registry is its statement in
the design body): every credential variable named at any catalog layer in
any entry state (`authTokenEnv`, `balanceKeyEnv`, every header variable —
enabled, disabled, retained default, or template), every **secret-source**
store key, and every retained name (persisted names-only, never removed).
Not in the set: launch-env store entries as such, the controlled/
transport-pin variables (branch operations, not secrets — the composition
table applies them per branch), and ambient names nothing registers.
**Stage:** this table decides the registered-name **filter, which runs
before the launch branch**; D5's composition table then applies each
branch's own operations to what passed. A `balanceKeyEnv` name is
registered like every binding name, but its only channel is the
**server-side usage pull** — no launch receives it at all, through no
binding.

| W# | Name registered? | Store entry kind | Passes the pre-branch filter? | Where it reaches a launch | Listing shows |
| --- | --- | --- | --- | --- | --- |
| W1 | no (ambient; nothing registers it) | — | yes — on every branch; the branch's own operations then apply (Default/wrapper keep it unchanged; a named-profile branch still deletes controlled variables the profile does not set; Codex composes its own env) | per D5's table — for Default/wrapper, unchanged ambient base URL or proxy, as today | source: process env / seed |
| W2 | yes — catalog binding, any entry state | — | no (`balanceKeyEnv`: its channel is the server-side usage pull, never a launch) | only through a binding (token / composed headers) | registered name |
| W3 | yes — secret-source store key | secret source | no | only through a binding | kind: secret source |
| W4 | yes — header variable, any state | — | no | only inside composed `ANTHROPIC_CUSTOM_HEADERS` | registered name |
| W5 | yes — retained name | — | no | only through a binding | registered name |
| W6 | no | launch-env | yes — delivered through the branch's composition, like W1 | as itself (branch operations as W1) | kind: launch-env |
| W7 | yes | launch-env (migrated or saved) | **no** — registered-name withholding wins over delivery (L-H); save/import/migration keep it inert | — | collision, naming the variable and the supported credential setting |
| W8 | yes — name stayed registered through reclassification | launch-env (was a secret source) | no, while the name stays registered | — | collision, naming the variable |
| W9 | no | launch-env migrated from a legacy credential name (e.g. the Settings `ANTHROPIC_API_KEY`) | yes — the one legacy exception to "only composed token/header forms reach a launch"; possibly secret, never called non-secret | as itself, through the branch's composition (pre-upgrade delivery kept) | kind: launch-env (legacy) |

Unreachable rows (with reasons): (i) a launch-env entry **delivered** while
its name is registered — W7/W8 withhold it; every write path (save, import,
migration) keeps it inert and reports instead of delivering; (ii) a secret
source delivered under its own name — W2–W5 route it through a binding
only; (iii) an agent-readable credential value outside the composed token/
header variables and W6/W9's own-name delivery — the read surfaces show
names only (P2).

Collision and reclassification precedence (one rule): registration follows
**names**, not kinds. Any write that would deliver a launch-env entry whose
name is registered keeps it stored-but-inert and reports the collision,
naming the variable and the supported credential setting (bind it, or use a
different variable name). Delivery resumes only when the name is no longer
registered — retained names never leave the registry, so rename and bind
are the honest resolutions. Inert means not delivered under its own name;
the entry still composes through resolution for a binding that names it
(W2's channel).

### P1 and P2 (lines 1173-1195)

- **P1 — Credential secrecy.** No credential value (store value, token,
  header value, balance key) appears in any HTTP response body, log line,
  wire-log frame, SQLite row, flag settings layer, or client payload —
  including the retired Settings path (post-migration, `app_settings`
  gains no new values); the only agent-visible forms are
  `ANTHROPIC_AUTH_TOKEN`, the composed `ANTHROPIC_CUSTOM_HEADERS`, and the
  launch-env entries table W delivers (W6, and the legacy exception W9 —
  possibly secret, never called non-secret); every registered name is
  absent under its own name
  (mechanism parity with today's token path; measured exposure is the
  sentinel fixture's, D12). Redaction of exact values is tested with
  unshaped sentinels, split chunks, and overlapping values, not only the
  shape patterns. Error and listing text is fixed and safe — parser
  messages, fs errors, and cause chains never surface. Generator: seeded
  run over random secret shapes; seams:
  the store module, the preview/listing projector, the classifier's
  redactor, the launch composer. Fixed seed, 200 cases, no new dependency.
- **P2 — Write-only store UI.** After any import/replace/blank/clear
  sequence, every read surface returns presence, source, and name only —
  never the value, a prefix, or its length, whatever the variable is named
  (the old name-regex hole is closed). Generator: random operation
  sequences; seam:
  the Settings/projector read paths.

### D12 obligations 2 and 6 (lines 933-954, 966-969)

2. **Credential-store IO** (D1): atomic write (temp `O_EXCL|O_NOFOLLOW`
   0600 + fchmod + fsync + rename), symlink refusal, the permission
   semantics (created 0600 never widened; 0400 readable and explicitly
   replaceable at 0600; any group/other bit refuses reads and mutations,
   never auto-chmodded), the security gates before every access including
   cache hits (lstat regular file/EUID owner/zero group-other bits,
   `O_NOFOLLOW` read with matched `fstat` identity), one module-owned
   per-file coordination owner for the cache and the whole RMW queue across
   every instance and the migration, applied/durable typed outcomes with
   cache invalidation and verified reload on applied-but-not-durable, fixed
   value-free error text (no parser message or cause chain), the required
   retain-name collaborator refusing secret-source mutations before any
   file change, the local name-pattern duplicates with their separated
   equivalence tests (the secret-source catalog rule; the legacy
   store-wide shape) and the NUL boundary (write refusal for both kinds,
   a stored NUL reading malformed) — plus the crash-safe migration per
   D1's
   table: the durable store-file write lands **before** the one SQLite
   transaction that deletes the map row and commits the stamp, and that
   transaction runs only on a durable acknowledgement (the file write is
   never transactional with SQLite); a restored pre-upgrade backup re-runs
   it.
6. **Migration crash/collision/restart table** (D1): the file-first
   ordering (store write durable before any SQLite write), absorption and
   collision behavior at each crash point, stamp idempotence, and the
   restored-pre-upgrade-backup re-run.
