# Design

## Context

`provider-relay-setup` §1 landed as 9e91a8dc (2026-10-25, "secret-name
registry and the filtered-env launch audit", #325) and 6c1a3b04 (refusal of
launches whose mandatory composition carries a registered name). This
closeout slice archives exactly that behavior. It writes no production
code. Everything not yet landed stays with its named slice or the held
install-modes lineage (proposal, "Not in this change").

Source pin for every fact below: `f52963d0ab20d5ff9693fcd941e3c3f17970aa26`.

## Current inventory at f52963d0

- `src/server/chat/secretNameRegistry.ts` (138 lines): `registeredSecretNames`
  unions four sources. Only `catalogNames` and `retainedNames` are fed in
  production: `catalogRegisteredNames` (:132) passes the catalog's parsed-layer
  `credentialNames`, and the header (§4) and store-key (§2) sources are
  explicit, empty parameters (:22-31, :129-131). `RETAINED_SECRET_NAMES_KEY =
  'registered_secret_names'` (:12) persists names only; a malformed value
  reads empty with a warning and heals at the next observation (:50-65).
  `collidingLaunchEnvNames` (:97) is dormant ("Dormant until §7 wires it",
  :95). `RegisteredNameRefusal` (:112) is the typed pre-spawn refusal.
- Production consumers: `ClaudeProfiles.ts:17,92,133` (the withheld set for
  every Claude branch) and `:215,217` (credentialed and named-profile
  refusals); `codexProfiles.ts:9,76` (registered `CODEX_HOME` refusal);
  `ChatSessionManager.ts:81,2010,2085` (the refusal settles the send failed);
  `ChatSessionManager.ts:2966` (Codex respawn re-derives the set);
  `provider/claudeRuntimeLaunch.ts:24` and `provider/claudeDriverTypes.ts:15`
  (the `RetainedNamesDb` seam on the driver path); `chatProviderEnv.ts:8,98`
  (`withheldCredentialNames`, the catalog's contribution).
- Tests (current evidence, literal titles in the map below):
  `src/server/__tests__/secretNameRegistry.test.ts`,
  `registeredNamesWithholding.test.ts`, `registeredNameSurvivesRemoval.test.ts`,
  `registeredNamesRefusals.test.ts`, `registeredNamesRefusalWiring.test.ts`,
  `registeredNamesManagerWiring.test.ts`, `registeredNamesRetention.test.ts`.
  Their `@covers` annotations name `provider-relay-setup`'s delta scenarios.
- Not present: header variables (no `headers` field in `catalogParse.ts`), a
  wired credential store (no production importer of `credentialStore.ts`),
  a source listing, and the `enabled: false` field.

## Source partition (this slice's rows)

Rows of the complete relay partition (`fixture-relay/design.md`) owned here:

| Source item (provider-relay-setup at f52963d0) | Disposition here |
| --- | --- |
| task 1.1 (registry replaces resolved-catalog-only withholding) | landed 9e91a8dc; closeout task 1.1 maps it |
| task 1.2 (filtered-env audit on every branch) | landed 9e91a8dc/6c1a3b04; closeout task 1.1 maps it |
| requirement "Registered secret names stay withheld" | ADDED here in its landed form (catalog + retained sources) |
| scenario "Removing a provider keeps its names withheld" | here, unchanged |
| scenario "An ambient route survives a Default launch" | here, unchanged |
| scenario "A launch-env entry colliding with a registered name stays inert" | here, launch half; the listing half moves to `relay-setup-flow` ("A launch-env collision is listed") |
| scenario "A disabled entry's variables stay withheld" | held (install-modes 3.3, `enabled: false`); this slice records the landed parse-layer mechanism as "A dropped entry's variables stay withheld" |
| scenario "Reclassification does not end withholding" | `provider-credential-store` (MODIFIED block) |
| body clauses "every header variable" / "every secret-source store key" | `relay-headers` / `provider-credential-store` |

## Decisions

**Narrow the requirement to what production enforces.** Archiving the
umbrella's wording would put clauses into main that no production path
implements (store keys, header variables, listing). Main specs ahead of code
is the defect class the remaining-backlog audit found in
`chat-usage-limits` (audit 77b1d587 part 01, G2). Each removed clause has a
named owner above. Alternative rejected: archive the full text and rely on
later slices — it leaves untested scenarios in main.

**Keep the landed refusal in the requirement.** `RegisteredNameRefusal`
(6c1a3b04) is observable behavior (a send settles failed, no child starts)
that the umbrella text never stated. Stating it now keeps main faithful to
the code.

**No code change.** Any defect found while mapping is reported to the Lead
as a follow-up; this slice does not fix it.

## Acceptance oracles

Rows inherited from the umbrella's table W (appendix, verbatim) that this
slice certifies. W3, W4 and W8 need sources that do not exist yet; they
stay with `provider-credential-store` / `relay-headers`. W6 and W9 belong to
the store's launch-env kind and are re-certified there.

| Id | Input | Observable result | Current evidence (`file` › `title`) |
| --- | --- | --- | --- |
| R-W1 | ambient name nothing registers, Default/wrapper launch | delivered unchanged | `src/server/__tests__/registeredNamesWithholding.test.ts` › `an unregistered ambient route survives Default and wrapper launches` |
| R-W2 | catalog binding, any parsed layer and state | absent from every launch under its own name | `src/server/__tests__/registeredNamesWithholding.test.ts` › `a removed provider entry keeps its names withheld from every launch` |
| R-W5 | retained name, entry removed | absent from every launch, still deliverable through its binding | `src/server/__tests__/registeredNamesRefusals.test.ts` › `a retained token name still delivers under ANTHROPIC_AUTH_TOKEN after removal (row 6)` |
| R-W7 | launch-env entry whose name is registered | not delivered | `src/server/__tests__/registeredNamesWithholding.test.ts` › `a legacy launch-env entry colliding with a retained name is not delivered (W7)` |
| R-RF | named-profile / credentialed / Codex branch must compose a registered name | send settles failed, no launch, the error names the variable | `src/server/__tests__/registeredNamesRefusalWiring.test.ts` › `a send into a credentialed profile settles failed with no launch; clearing it launches and pins` |
| R-MW | respawn or restart after removal | set re-derived, removed names stay withheld | `src/server/__tests__/registeredNamesManagerWiring.test.ts` › `a respawn and a restart keep removed entries withheld (M1b)` |
| R-MK | malformed `registered_secret_names` | warns naming the key, live names still withheld, heals | `src/server/__tests__/registeredNamesRetention.test.ts` › `a malformed retained key warns and live catalog names stay withheld` |

Property **P7r** (the landed half of the umbrella's P7): remove/drop/clear
sequences at the registry seam never let an ever-registered name reach a
probe launch. Current evidence: `src/server/__tests__/registeredNamesRetention.test.ts`
› `every remove/disable/clear/reclassify sequence keeps registered names withheld`
(seeded, at the registry seam; its reclassify op uses an injected store-key
source, so it is seam evidence for the store slice, not production evidence).

Scenario → evidence map (the closeout result cites these literally):

| Scenario | Tests |
| --- | --- |
| Removing a provider keeps its names withheld | `src/server/__tests__/registeredNameSurvivesRemoval.test.ts` › `a removed provider entry keeps its names withheld`; R-W2; R-MW |
| A dropped entry's variables stay withheld | `src/server/__tests__/registeredNamesWithholding.test.ts` › `an entry outside the resolved catalog in any state keeps its names withheld` |
| An ambient route survives a Default launch | R-W1; `src/server/__tests__/registeredNamesRefusals.test.ts` › `a Default launch keeps unregistered ambient route variables (row 8, W1)` |
| A launch-env entry colliding with a registered name stays inert | R-W7; R-RF; `src/server/__tests__/registeredNamesRefusals.test.ts` › `codexSpawnEnv refuses a registered CODEX_HOME before composing` |

## Implementation contract

### Acceptance
- A1: The result's coverage map cites, for each of the four scenarios of "Registered secret names stay withheld" in this change's delta, at least one existing test by literal title, and every cited test passes in the result's clean full-properties certificate run.
- A2: Each test cited for "A dropped entry's variables stay withheld" carries a `// @covers: provider-credentials › Registered secret names stay withheld › A dropped entry's variables stay withheld` annotation, and `scripts/__tests__/specCoverageGuard.test.ts` passes.
- A3: At most five hand-applied mutants of the registry wiring (for example: drop `retainedNamesDb` in `catalogRegisteredNames`, skip the `RegisteredNameRefusal` throw at `ClaudeProfiles.ts:215`, bypass `codexProfiles.ts:76`) each fail at least one cited test; the result lists each mutant and the failing test title.
- A4: After archive, `openspec/specs/provider-credentials/spec.md` holds exactly this change's one requirement and its four scenarios, and `openspec validate --specs --strict` passes.

### Invariants
- I1: No production source, configuration, or package file changes; test files change only by added `@covers` comment lines.
- I2: `openspec/changes/provider-relay-setup/**` stays byte-identical to f52963d0, and no task status, direction, or branch of the held relay lineage changes.

### Scope
- `openspec/changes/provider-relay-secret-registry/**`
- `openspec/specs/provider-credentials/spec.md`
- `src/server/__tests__/registeredNamesWithholding.test.ts`
- `src/server/__tests__/registeredNameSurvivesRemoval.test.ts`

### Verification
- V1: The literal-citation preflight (`.kawai/validation.md`) reports zero unresolved citations for the result's map before the final campaign.
- V2: A clean committed tree passes `bun run check --full-properties` under the pinned Bun 1.4.3, and `bun scripts/verify-result.ts --commit <head> --coverage <map>` exits 0.
- V3: `openspec validate provider-relay-secret-registry --strict` passes before archive; the archive commit's `openspec validate --specs --strict` passes.

### Excluded
- X1: Secret-source store keys and the reclassification scenario (owned by `provider-credential-store`).
- X2: Header variables (owned by `relay-headers`).
- X3: The source-listing collision report and wiring `collidingLaunchEnvNames` (owned by `relay-setup-flow`).
- X4: `enabled: false` and every install-mode, trim, retained-layer, or template behavior (held install-modes lineage, owner decision).
- X5: Any edit to, tick of, adoption of, or cancellation of `provider-relay-setup` or its tasks.

## Execution checkpoints

1. Map checkpoint (no code): the scenario map above, re-checked against the
   current head with the citation preflight; any title drift is fixed in the
   map, not by renaming tests.
2. Mutant checkpoint: A3's mutants run in a disposable checkout; the result
   records them. No production-path checkpoint is needed — the cited wiring
   tests (R-RF, R-MW) already drive the real `ChatSessionManager`.
3. Archive: sync and archive in one commit, before the complete
   replacement result and its final review.

## Dependencies and serialization

- Prerequisites: none (the code is on master).
- Archive order: this change archives **before** `provider-credential-store`
  (its MODIFIED block targets this requirement). It creates the
  `provider-credentials` main spec, so any other change adding to that
  capability archives after it.
- No edge to `rename-agentboard-to-kawai`, `openrouter-provider`, or
  `mimo-million-token-context`. The `[agentboard]` log prefix in
  `secretNameRegistry.ts:57,61,85` is the rename's to change, not this
  slice's.
- `provider-relay-setup` keeps its own ADDED copy of this requirement until
  its reconciliation (`fixture-relay` task 3.3); both texts coexist while
  the umbrella is held, and the umbrella's archive (if ever) must drop or
  re-derive it.

## Risks

- The umbrella's `@covers` annotations keep naming its own scenarios; the
  guard resolves them against active deltas, so they keep passing while the
  umbrella is unarchived. A future retirement of the umbrella must move or
  drop those annotations in the same change.
- Seam-only evidence (P7r's reclassify op) is labeled seam evidence; it is
  not claimed as production coverage.

## Appendix — inherited text (verbatim from `provider-relay-setup/design.md` at f52963d0)

The following lines are copied unchanged for implementer context. Where they
mention header variables, secret-source store keys, `enabled`, templates,
retained defaults, or `KAWAI_CHAT_ENV`, the sections above decide what this
slice owns; the appendix grants no scope.

### From D2 (lines 374-392)

**Secret-name registry (the one registered-name set, table W).**
Withholding can no longer derive only from the resolved catalog
(`withheldCredentialNames` reads resolved entries, so removing or disabling
an entry un-hides its variables — `chatProviderEnv.ts:95–112`). The
registered set is the union of: every credential variable named at **any**
catalog layer (parsed before `enabled` filtering, so a disabled entry's
names stay withheld), every header variable, every **secret-source** store
key, and the **retained names** — every name ever registered, persisted in
an `app_settings` key (names only, never values; names are not secrets).
Registration follows **names**, not kinds: a launch-env store entry is
delivered unchanged (W6) unless its name is in this set, in which case save,
import, and the migration keep it inert and report the collision, naming
the variable and the supported credential setting (W7); reclassifying an
entry between kinds never ends withholding while the name stays registered
(W8). A migrated legacy credential name that nothing registers is the one
delivery exception (W9): it keeps its pre-upgrade delivery and is stated as
possibly secret, never non-secret. Removing a provider entry, disabling an
id, or clearing a header binding never stops withholding its names; a
remove-provider or remove-binding oracle test pins this (P7).

### From D5 (lines 610-640)

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

### P7 (lines 1239-1249)

- **P7 — Withholding survives removal; registration wins delivery.**
  Removing a provider entry, disabling an id, or clearing a header binding
  never stops withholding its registered secret names (all-layer catalog
  names ∪ header variables ∪ secret-source store keys ∪ retained names,
  names only in `app_settings`); no Claude or Codex launch receives a
  registered name under its own name — a launch-env entry whose name is
  registered stays inert with the collision reported (W7/W8), while
  unregistered launch-env entries deliver unchanged (W6) and a Default or
  wrapper launch keeps its ambient base URL or proxy (W1).
  Generator: remove/disable/clear/reclassify sequences with a probe launch;
  seams: the withheld-name set successor and the launch composer.
