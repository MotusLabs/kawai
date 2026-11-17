# Design

## Context

This slice owns three umbrella tasks: 11.1 (the fixture-relay e2e), 11.2
(final docs), and 11.3 (archive order, replaced here by a reconciliation
proposal). It also records the canonical partition of `provider-relay-setup`
across the five slices and the held lineage. It adds no requirement
(`skip_specs: true`). The scenarios its e2e exercises belong to the slices
that ADD them, and its tests annotate those scenarios with `@covers`.

Source pin: `f52963d0ab20d5ff9693fcd941e3c3f17970aa26`.

## Current inventory at f52963d0

- Fixture CI path: `.github/workflows/ci.yml:165-173` runs
  `specs=$(bun scripts/e2e-fixture-specs.ts)` and then
  `NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test $specs --workers=1`.
  `scripts/e2e-fixture-specs.ts:14` (`FIXTURE_VAR = 'AGENTBOARD_CHAT_FIXTURE'`)
  lists every spec that runs only with the fixture on (#418). A new
  fixture-gated spec needs no registration.
- Existing fixture-gated neighbors: `tests/e2e/chat-profiles.spec.ts:6`
  (`test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', …)`),
  `tests/e2e/settings-provider.spec.ts`, `tests/e2e/new-session-defaults.spec.ts`.
  Helpers: `tests/e2e/fixtures/serverProcess.ts`, `privateTmux.ts`.
- The development chat fixture (`src/server/chat/developmentFixture.ts:1-19`)
  is a fake SDK that "never spawns a process", enabled by
  `NODE_ENV=development` + `AGENTBOARD_CHAT_FIXTURE=1`. It cannot by itself
  show that a launch's composed environment reached a relay (FR-D1).
- No loopback relay helper exists in `tests/e2e/fixtures/`.

## Decisions

**FR1 — One spec, one relay helper.** `tests/e2e/relay-setup.spec.ts` is
fixture-gated like its neighbors. A loopback relay helper (proposed
`tests/e2e/fixtures/fixtureRelay.ts`) serves the Anthropic-compatible
endpoints the flow touches: `/v1/models`, and `/v1/messages` with scripted
outcomes (ok, 403 + documented virtual-key type, 403 prose-only). It records
every request's headers so the spec can assert them. Sentinel values only.
The relay binds to 127.0.0.1 on a spare port.

**FR-D1 (open; decide at checkpoint 1).** Which runtime carries the session
request to the relay? (a) The real Claude CLI against the loopback relay,
with sentinel credentials and no network beyond loopback, proving
composition through the CLI's own request path. This is recommended if CI
can run the pinned CLI. (b) Otherwise, a development-fixture mode that
performs the session's request with the composed launch environment. That
proves composition to the HTTP edge, not the CLI, and the result and docs
must say so. Either choice keeps the live-error assertions meaningful,
because the error row is produced by Kawai's projection (`relay-setup-flow`
SFW4).

**FR2 — Reconciliation is a proposal, not an edit.** After every executable
slice has landed and archived, task 3.3 writes a reconciliation note: the
landed slices with their archive commits, the held rows below unchanged, and
two options for the umbrella. (i) Retire it; the held install-modes scope
moves to a fresh owner-approved change when the owner releases the hold.
(ii) Narrow it to the held scope. The owner decides. This change never edits
`openspec/changes/provider-relay-setup/**`.

## Acceptance oracles

| Id | Step (fresh disposable instance) | Observable |
| --- | --- | --- |
| FR-1 | configure relay through the setup editor (base URL, token variable, `x-bf-vk` binding, model IDs), confirming the replace-mode preview | one user-level provider entry; values only in the disposable store; no value in the catalog file |
| FR-2 | run the connection test per model | each card shows `success`; the relay saw the composed token and `x-bf-vk` |
| FR-3 | create a session and send one message | the relay received `ANTHROPIC_CUSTOM_HEADERS`' pair and the token (per FR-D1's runtime) |
| FR-4 | relay scripts 403 with the documented virtual-key type | live error row shows `virtual-key-restriction`; no limit event, cooldown, or parked mail |
| FR-5 | relay scripts 403 prose-only | live error row shows the evidence-qualified unknown with the list note |
| FR-6 | any diagnostic surface (test card, error row, listing, preview) | sentinel values appear only redacted |
| FR-7 | model list lacks one configured model | the picker marks that profile; creation still allowed |

Production composition: the whole spec runs against the built server
(`dist/client`, production routes) in a disposable checkout and database on
a spare port. It never uses hand-built server objects. Mutant (run once in
the disposable checkout and recorded): drop the header composition at
launch, and FR-3 must fail.

## Relay partition inventory (canonical)

### Tasks (all 41)

| Umbrella task | Owner | Note |
| --- | --- | --- |
| 1.1, 1.2 | `provider-relay-secret-registry` | landed 9e91a8dc / 6c1a3b04; closeout map |
| 2.1 | `provider-credential-store` | landed #354, dormant; evidence mapped in its 1.2 |
| 2.2, 2.3, 2.4, 2.5, 2.6 | `provider-credential-store` | groups 3, 2, 4, 4, 5 |
| 3.1, 3.2, 3.3, 3.4, 3.5 | **held** | install modes, merge, tombstone; task-c6bfbd04, `feat/relay-install-modes` bddbdb42 |
| 4.1, 4.2, 4.3 | `relay-headers` | groups 1, 2, 3 |
| 5.1, 5.2, 5.3, 5.4, 5.5 | **held** | shipped trim, retained layer, retire, degrade; same lineage |
| 6.1 | `relay-setup-flow` | group 1 |
| 6.2 | `relay-setup-flow` (editor) / **held** (template adoption) | adoption needs held 5.1 templates |
| 7.1 | `relay-setup-flow` / **held** (install-mode label, retained marks, damaged record) | |
| 7.2, 7.3, 7.4 | `relay-setup-flow` | group 2 |
| 8.1–8.5 | `relay-setup-flow` | group 3; 8.1 retargeted from `ChatSessionDriver` to `claudeRuntimeLaunch.ts` |
| 9.1, 9.2, 9.3 | `relay-setup-flow` | group 4; 9.3 retargeted to the runtime error event + `runtimeEvents.ts` |
| 10.1, 10.2, 10.3 | `relay-setup-flow` | group 5 |
| 11.1 | `fixture-relay` | group 1 here |
| 11.2 | `fixture-relay` / **held** (install-mode, retained, degrade docs) | group 2 here |
| 11.3 | `fixture-relay` (replaced) | the rename-first archive order is dropped; group 3 here writes the reconciliation proposal |

### Requirements and scenarios (all 123 scenarios + 1 REMOVED requirement)

Generated from `openspec/changes/provider-relay-setup/specs/**` at f52963d0.
Each row has exactly one owner. A row's note names where a split-off half
of the scenario went.

| # | Capability | Delta | Requirement | Scenario | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Small override preserves shipped siblings | **held** (install modes/trim, task-c6bfbd04) |  |
| 2 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Complete user files keep the same catalog | **held** (install modes/trim, task-c6bfbd04) |  |
| 3 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Nearest file wins | **held** (install modes/trim, task-c6bfbd04) |  |
| 4 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Per-key extension | **held** (install modes/trim, task-c6bfbd04) |  |
| 5 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Neutralizing an inherited value | **held** (install modes/trim, task-c6bfbd04) |  |
| 6 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Provider overlay | **held** (install modes/trim, task-c6bfbd04) |  |
| 7 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Overlay of a shipped provider's base URL | **held** (install modes/trim, task-c6bfbd04) |  |
| 8 | claude-session-profiles | MODIFIED | Profile catalog files are discovered and merged | Mounted catalog replaces the image default | **held** (install modes/trim, task-c6bfbd04) |  |
| 9 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | Effective global provider overrides | `provider-credential-store` |  |
| 10 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | A seed-only sibling key survives | `provider-credential-store` |  |
| 11 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | Default and named profiles over the merged environment | `provider-credential-store` |  |
| 12 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | GLM configuration | `provider-credential-store` |  |
| 13 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | MiniMax and MiMo configuration | `provider-credential-store` |  |
| 14 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | Kimi configuration | `provider-credential-store` |  |
| 15 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | Profiles do not leak between sessions | `provider-credential-store` |  |
| 16 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | Conflicting Claude settings | `provider-credential-store` |  |
| 17 | claude-session-profiles | MODIFIED | Named profiles configure independent provider sessions | Global provider settings coexist with profiles | `provider-credential-store` |  |
| 18 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | A fresh install merges over the shipped tier | **held** (install modes/trim, task-c6bfbd04) |  |
| 19 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | An install with user files keeps replace until the operator opts in | **held** (install modes/trim, task-c6bfbd04) |  |
| 20 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | The opt-in follows a preview | **held** (install modes/trim, task-c6bfbd04) |  |
| 21 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | The retained layer serves removed ids | **held** (install modes/trim, task-c6bfbd04) |  |
| 22 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | A fresh install never acquires the retained layer | **held** (install modes/trim, task-c6bfbd04) |  |
| 23 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | An upgraded install keeps the retained layer across restarts | **held** (install modes/trim, task-c6bfbd04) |  |
| 24 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | Retire stays retired | **held** (install modes/trim, task-c6bfbd04) |  |
| 25 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | A damaged record refuses instead of re-deriving | **held** (install modes/trim, task-c6bfbd04) |  |
| 26 | claude-session-profiles | ADDED | The install mode decides how the shipped tier composes | The default profile cannot be disabled | **held** (install modes/trim, task-c6bfbd04) |  |
| 27 | claude-session-profiles | ADDED | A user-level entry may disable an id | Disable removes an id | **held** (install modes/trim, task-c6bfbd04) |  |
| 28 | claude-session-profiles | ADDED | A user-level entry may disable an id | A project file cannot resurrect a tombstoned id | **held** (install modes/trim, task-c6bfbd04) |  |
| 29 | claude-session-profiles | ADDED | A user-level entry may disable an id | A project file cannot disable | **held** (install modes/trim, task-c6bfbd04) |  |
| 30 | claude-session-profiles | ADDED | A user-level entry may disable an id | A project file cannot re-home a credentialed provider | **held** (install modes/trim, task-c6bfbd04) |  |
| 31 | claude-session-profiles | ADDED | A user-level entry may disable an id | Labels and model mappings may overlay a credentialed id | **held** (install modes/trim, task-c6bfbd04) |  |
| 32 | claude-session-profiles | ADDED | A user-level entry may disable an id | Disabling the default profile is refused | **held** (install modes/trim, task-c6bfbd04) |  |
| 33 | claude-session-profiles | ADDED | A provider may bind custom headers to credential variables | A project file cannot bind headers | `relay-headers` |  |
| 34 | claude-session-profiles | ADDED | A provider may bind custom headers to credential variables | Case-insensitive collision is refused | `relay-headers` |  |
| 35 | claude-session-profiles | ADDED | A provider may bind custom headers to credential variables | Empty variable omits the header | `relay-headers` | preview half → `relay-setup-flow` "A missing header variable is marked" |
| 36 | claude-session-profiles | ADDED | Bound headers compose into the launch environment | Header binds a virtual key | `relay-headers` |  |
| 37 | claude-session-profiles | ADDED | Bound headers compose into the launch environment | Header values stay out of the settings layer | `relay-headers` |  |
| 38 | claude-session-profiles | ADDED | A headers-only provider pins its route | A headers-only provider pins its route | `relay-headers` |  |
| 39 | claude-session-profiles | ADDED | A headers-only provider pins its route | Headers-only provider without a base URL | `relay-headers` |  |
| 40 | claude-session-profiles | ADDED | The shipped catalog carries Anthropic and OpenAI only | A fresh instance resolves the shipped set | **held** (install modes/trim, task-c6bfbd04) |  |
| 41 | claude-session-profiles | ADDED | The shipped catalog carries Anthropic and OpenAI only | A tracked relay id warns on a fresh install | **held** (install modes/trim, task-c6bfbd04) |  |
| 42 | claude-session-profiles | ADDED | The shipped catalog carries Anthropic and OpenAI only | A retained context resolves every tracked worker | **held** (install modes/trim, task-c6bfbd04) |  |
| 43 | claude-session-profiles | ADDED | The shipped catalog carries Anthropic and OpenAI only | Templates carry the removed ids | **held** (install modes/trim, task-c6bfbd04) |  |
| 44 | claude-session-profiles | ADDED | Removed shipped profiles degrade without a template | Stored session blocks and names the template | **held** (install modes/trim, task-c6bfbd04) |  |
| 45 | claude-session-profiles | ADDED | Removed shipped profiles degrade without a template | Group references are warned and skipped | **held** (install modes/trim, task-c6bfbd04) |  |
| 46 | claude-session-profiles | ADDED | Removed shipped profiles degrade without a template | Template adoption restores resolution | **held** (install modes/trim, task-c6bfbd04) |  |
| 47 | claude-session-profiles | ADDED | An empty declared worker list never falls back to the default profile | All declared workers unknown holds the mail | **held** (install modes/trim, task-c6bfbd04) |  |
| 48 | claude-session-profiles | ADDED | An empty declared worker list never falls back to the default profile | Restoring an id ends the wait | **held** (install modes/trim, task-c6bfbd04) |  |
| 49 | claude-session-profiles | ADDED | An empty declared worker list never falls back to the default profile | A group without a worker field keeps the default profile | **held** (install modes/trim, task-c6bfbd04) |  |
| 50 | claude-session-profiles | ADDED | Profiles are marked when the provider's catalog lacks their model | Unavailable model is marked | `relay-setup-flow` |  |
| 51 | claude-session-profiles | ADDED | Profiles are marked when the provider's catalog lacks their model | Unknown catalog marks nothing | `relay-setup-flow` |  |
| 52 | claude-session-profiles | REMOVED requirement | The shipped catalog includes OpenRouter | (whole requirement) | **held** (install modes/trim, task-c6bfbd04) | REMOVED target exists only after `openrouter-provider` archives; stays with the trim |
| 53 | profile-limit-handling | ADDED | Connection failures are diagnostics, never limits | A relay 403 cools nothing | `relay-setup-flow` |  |
| 54 | profile-limit-handling | ADDED | Connection failures are diagnostics, never limits | A limit-shaped 403 cools as before | `relay-setup-flow` |  |
| 55 | profile-limit-handling | ADDED | Connection failures are diagnostics, never limits | The limit table is unchanged | `relay-setup-flow` |  |
| 56 | profile-limit-handling | ADDED | Connection tests never record limits | A test 429 reports and records nothing | `relay-setup-flow` |  |
| 57 | profile-limit-handling | ADDED | Connection tests never record limits | A test 402 reports the credit class | `relay-setup-flow` |  |
| 58 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Import writes only the store | `provider-credential-store` |  |
| 59 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Corrupt store degrades visibly | `provider-credential-store` |  |
| 60 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Invalid store is never salvaged | `provider-credential-store` |  |
| 61 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Legacy launch-env names are preserved | `provider-credential-store` |  |
| 62 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Secret sources require catalog-compatible names | `provider-credential-store` |  |
| 63 | provider-credentials | ADDED | Imported credentials live in the server-owned store | NUL never enters or persists in the store | `provider-credential-store` |  |
| 64 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Unsafe permissions refuse every access | `provider-credential-store` |  |
| 65 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Gates precede any cached value | `provider-credential-store` |  |
| 66 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Applied and durable report separately | `provider-credential-store` |  |
| 67 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Secret-source changes retain the name first | `provider-credential-store` |  |
| 68 | provider-credentials | ADDED | Imported credentials live in the server-owned store | A change that changes nothing writes nothing | `provider-credential-store` |  |
| 69 | provider-credentials | ADDED | Imported credentials live in the server-owned store | Blank is a stored state for both kinds | `provider-credential-store` |  |
| 70 | provider-credentials | ADDED | The credential UI is write-only | Presence without value | `provider-credential-store` |  |
| 71 | provider-credentials | ADDED | The credential UI is write-only | Replace requires retyping | `provider-credential-store` |  |
| 72 | provider-credentials | ADDED | The credential UI is write-only | Errors carry fixed safe text only | `provider-credential-store` |  |
| 73 | provider-credentials | ADDED | Credential resolution composes per variable | Store overrides the ambient environment | `provider-credential-store` |  |
| 74 | provider-credentials | ADDED | Credential resolution composes per variable | A launch-env entry is delivered unchanged | `provider-credential-store` |  |
| 75 | provider-credentials | ADDED | Credential resolution composes per variable | A seed-only sibling key survives | `provider-credential-store` |  |
| 76 | provider-credentials | ADDED | Credential resolution composes per variable | A secret source never rides the launch environment | `provider-credential-store` |  |
| 77 | provider-credentials | ADDED | Credential resolution composes per variable | Gate and spawn agree through the store | `provider-credential-store` |  |
| 78 | provider-credentials | ADDED | Legacy Settings credentials migrate to the store at upgrade | Migration moves the map once | `provider-credential-store` |  |
| 79 | provider-credentials | ADDED | Legacy Settings credentials migrate to the store at upgrade | A crash before the database commit recovers | `provider-credential-store` |  |
| 80 | provider-credentials | ADDED | Legacy Settings credentials migrate to the store at upgrade | A restored pre-upgrade backup re-runs the migration | `provider-credential-store` |  |
| 81 | provider-credentials | ADDED | Legacy Settings credentials migrate to the store at upgrade | Backups taken before the commit are named honestly | `provider-credential-store` |  |
| 82 | provider-credentials | ADDED | Registered secret names stay withheld | Removing a provider keeps its names withheld | `provider-relay-secret-registry` |  |
| 83 | provider-credentials | ADDED | Registered secret names stay withheld | A disabled entry's variables stay withheld | **held** (install modes/trim, task-c6bfbd04) | landed parse-layer mechanism recorded by `provider-relay-secret-registry` as "A dropped entry's variables stay withheld" |
| 84 | provider-credentials | ADDED | Registered secret names stay withheld | An ambient route survives a Default launch | `provider-relay-secret-registry` |  |
| 85 | provider-credentials | ADDED | Registered secret names stay withheld | A launch-env entry colliding with a registered name stays inert | `provider-relay-secret-registry` | listing half → `relay-setup-flow` "A launch-env collision is listed" |
| 86 | provider-credentials | ADDED | Registered secret names stay withheld | Reclassification does not end withholding | `provider-credential-store` | MODIFIED block |
| 87 | provider-credentials | ADDED | Store changes apply at the next launch | Import then create | `provider-credential-store` |  |
| 88 | provider-credentials | ADDED | Store changes apply at the next launch | Running session keeps its environment | `provider-credential-store` |  |
| 89 | provider-setup | ADDED | Relay setup configures a provider in one flow | One-flow setup | `relay-setup-flow` |  |
| 90 | provider-setup | ADDED | Relay setup configures a provider in one flow | Template adoption restores ids | **held** (install modes/trim, task-c6bfbd04) | needs templates / retained layer / install-state record |
| 91 | provider-setup | ADDED | The setup write path is safe under failure and concurrency | Invalid entry refuses whole | `relay-setup-flow` |  |
| 92 | provider-setup | ADDED | The setup write path is safe under failure and concurrency | A concurrent edit conflicts instead of overwriting | `relay-setup-flow` |  |
| 93 | provider-setup | ADDED | The setup write path is safe under failure and concurrency | Adoption imports values only into the store | **held** (install modes/trim, task-c6bfbd04) | needs templates / retained layer / install-state record |
| 94 | provider-setup | ADDED | Configuration sources are listed with their status | Rejected file is named | `relay-setup-flow` |  |
| 95 | provider-setup | ADDED | Configuration sources are listed with their status | Credential presence is shown | `relay-setup-flow` |  |
| 96 | provider-setup | ADDED | Configuration sources are listed with their status | Retained entries are marked | **held** (install modes/trim, task-c6bfbd04) | needs templates / retained layer / install-state record |
| 97 | provider-setup | ADDED | Configuration sources are listed with their status | A migration skip is listed | `relay-setup-flow` |  |
| 98 | provider-setup | ADDED | Configuration sources are listed with their status | A damaged install-state record is named | **held** (install modes/trim, task-c6bfbd04) | needs templates / retained layer / install-state record |
| 99 | provider-setup | ADDED | Validation failures name the supported setting | Custom-headers rejection directs the operator | `relay-setup-flow` |  |
| 100 | provider-setup | ADDED | Validation failures name the supported setting | Failures are never silent | `relay-setup-flow` |  |
| 101 | provider-setup | ADDED | The effective configuration is previewed before creation | Preview equals the launch | `relay-setup-flow` |  |
| 102 | provider-setup | ADDED | The effective configuration is previewed before creation | Conflicting overrides warn | `relay-setup-flow` |  |
| 103 | provider-setup | ADDED | The effective configuration is previewed before creation | Values stay redacted | `relay-setup-flow` |  |
| 104 | provider-setup | ADDED | The connection test runs through the real launch path | Test exercises the resolved launch | `relay-setup-flow` |  |
| 105 | provider-setup | ADDED | The connection test runs through the real launch path | Timeout is bounded and reaped | `relay-setup-flow` |  |
| 106 | provider-setup | ADDED | The connection test runs through the real launch path | Test is transient | `relay-setup-flow` |  |
| 107 | provider-setup | ADDED | The connection test runs through the real launch path | A limit-shaped test outcome records nothing | `relay-setup-flow` |  |
| 108 | provider-setup | ADDED | The connection test runs through the real launch path | Concurrent test reports busy | `relay-setup-flow` |  |
| 109 | provider-setup | ADDED | The connection test covers Claude-runtime profiles | Codex test is not supported | `relay-setup-flow` |  |
| 110 | provider-setup | ADDED | The connection test covers Claude-runtime profiles | A headers-only profile tests without a token gate | `relay-setup-flow` |  |
| 111 | provider-setup | ADDED | Diagnostic output is redacted before any sink | Echoed secret is redacted | `relay-setup-flow` |  |
| 112 | provider-setup | ADDED | Diagnostic output is redacted before any sink | Spawn exception is redacted | `relay-setup-flow` |  |
| 113 | provider-setup | ADDED | Failure classes are distinguished with their evidence | A missing declared token refuses despite other credentials | `relay-setup-flow` |  |
| 114 | provider-setup | ADDED | Failure classes are distinguished with their evidence | A documented restriction type reads as restriction | `relay-setup-flow` |  |
| 115 | provider-setup | ADDED | Failure classes are distinguished with their evidence | Prose is never evidence | `relay-setup-flow` |  |
| 116 | provider-setup | ADDED | Failure classes are distinguished with their evidence | A schema-valid other 4xx reads as relay error | `relay-setup-flow` |  |
| 117 | provider-setup | ADDED | Failure classes are distinguished with their evidence | A limit-shaped 403 still cools | `relay-setup-flow` |  |
| 118 | provider-setup | ADDED | Failure classes are distinguished with their evidence | Limits are untouched | `relay-setup-flow` |  |
| 119 | provider-setup | ADDED | Live failures classify like tested ones | A documented restriction shows its class live | `relay-setup-flow` |  |
| 120 | provider-setup | ADDED | Live failures classify like tested ones | A prose-only 403 shows the unknown live | `relay-setup-flow` |  |
| 121 | provider-setup | ADDED | Model availability is checked against the provider's catalog | Absent model is marked | `relay-setup-flow` |  |
| 122 | provider-setup | ADDED | Model availability is checked against the provider's catalog | No list endpoint blocks nothing | `relay-setup-flow` |  |
| 123 | provider-setup | ADDED | Model availability is checked against the provider's catalog | Partial list reads unknown | `relay-setup-flow` |  |
| 124 | provider-setup | ADDED | Model availability is checked against the provider's catalog | Alias resolution precedes the comparison | `relay-setup-flow` |  |

Totals: **held** (install modes/trim, task-c6bfbd04): 39; `provider-credential-store`: 36; `relay-headers`: 7; `relay-setup-flow`: 39; `provider-relay-secret-registry`: 3; all rows: 124.

### Held rows (owner decision; nothing here is executable)

- Requirements "Profile catalog files are discovered and merged" (MODIFIED),
  "The install mode decides how the shipped tier composes", "A user-level
  entry may disable an id", "The shipped catalog carries Anthropic and
  OpenAI only", "Removed shipped profiles degrade without a template", "An
  empty declared worker list never falls back to the default profile", and
  the REMOVED "The shipped catalog includes OpenRouter".
- The scenarios "Template adoption restores ids", "Adoption imports values
  only into the store", "Retained entries are marked", "A damaged
  install-state record is named", and "A disabled entry's variables stay
  withheld".
- Tasks 3.1–3.5, 5.1–5.5, the adoption part of 6.2, the install-mode parts
  of 7.1 and 11.2.
- Tasks and branches: task-c6bfbd04 (r57, blocked), task-65da4225,
  task-a12940da (umbrella implementation, open), `feat/relay-install-modes`
  bddbdb42 (30 ahead / 637 behind f52963d0). Lead decisions, not actions of
  this change: task-cd6ffb9f (§2.1 core, active since 2026-10-28),
  task-62609b66, task-42c653e6, task-ec54bc33. `feat/relay-credential-store`
  and `feat/relay-credential-store-recovery` are fully merged (0 ahead).
- The REMOVED OpenRouter block also needs `openrouter-provider` archived
  first, because that is when its target exists in main.

### Slice graph

| Slice | Kind | Correctness prerequisites | Serialization only | Archive order |
| --- | --- | --- | --- | --- |
| `provider-relay-secret-registry` | closeout | — | — | first (creates `provider-credentials`) |
| `provider-credential-store` | implement (BREAKING data move) | — (core and registry on master) | `mimo-million-token-context`, `rename-agentboard-to-kawai` ("Named profiles…", `ClaudeProfiles.ts`, `ChatSessionManager.ts`) | after the registry |
| `relay-headers` | implement | `provider-credential-store` | mimo, rename group 1, held install modes (`catalogParse.ts`, `catalogMerge.ts`) | after credential-store |
| `relay-setup-flow` | implement | `provider-credential-store`, `relay-headers` | `codex-capacity-retry` (`packages/agent-runtime/src/usage/limits.ts`, Claude result paths), rename group 2 (`NewSessionModal.tsx`) | after headers |
| `fixture-relay` | integration e2e + docs + reconciliation | `relay-setup-flow` (and transitively all) | rename group 1 (`AGENTBOARD_CHAT_FIXTURE` name) | last; nothing to sync |
| held install modes/trim | **held** | owner release of task-c6bfbd04 | every catalog file | — |

There is no rename-first hard edge. The slices author against current main
(`AGENTBOARD_CHAT_ENV`), and whichever change archives later re-derives
shared blocks.

## Implementation contract

### Acceptance
- A1: `tests/e2e/relay-setup.spec.ts` is skipped without the fixture, is listed by `scripts/e2e-fixture-specs.ts`, and passes rows FR-1 to FR-7 in CI's fixture step or a disposable checkout, database, and spare port with CI's fixture setup.
- A2: The fixture relay records request headers and is reached only on 127.0.0.1; every value it receives is a sentinel.
- A3: FR-D1 is decided and journaled at checkpoint 1, and the result states which runtime carried FR-3 and what that proves.
- A4: The header-composition mutant makes FR-3 fail, recorded with the run's log hash.
- A5: `docs/claude-session-profiles.md` and the AGENTS.md profiles/limits bullets describe the landed relay behavior (store, headers, setup, test, classes, availability) and say nothing about install modes, templates, or retained defaults beyond naming them held.
- A6: After every executable slice archives, a reconciliation note lists each slice's archive commit, the unchanged held rows, and options (i) and (ii) for the umbrella, and is sent to the Lead for the owner's decision.

### Invariants
- I1: No test or rehearsal touches live data, the live server, or `bun run test:e2e`.
- I2: No real credential, relay, or non-loopback host is contacted.
- I3: `openspec/changes/provider-relay-setup/**` and the held tasks stay unchanged by this change.

### Scope
- `openspec/changes/fixture-relay/**`
- `tests/e2e/relay-setup.spec.ts`
- `tests/e2e/fixtures/fixtureRelay.ts`
- `src/server/chat/developmentFixture.ts`
- `docs/claude-session-profiles.md`
- `docs/architecture/**`
- `AGENTS.md`

### Verification
- V1: The e2e passes in CI's fixture step on the result's head; the run id and log are cited.
- V2: The citation preflight finds zero unresolved citations; the clean committed head passes `bun run check --full-properties` (pinned Bun 1.4.3); `bun scripts/verify-result.ts` exits 0.
- V3: The existing fixture-gated specs (`tests/e2e/chat-profiles.spec.ts`, `tests/e2e/settings-provider.spec.ts`, `tests/e2e/new-session-defaults.spec.ts`) still pass in the same fixture step.

### Excluded
- X1: Any requirement change (`skip_specs: true`).
- X2: Install modes, templates, retained defaults, retire, and degrade (held).
- X3: Editing, archiving, retiring, or narrowing `provider-relay-setup`; the owner decides on the reconciliation note.
- X4: Running anything against the operator's live install.

## Execution checkpoints

1. Decide FR-D1 with one disposable-checkout probe of the chosen runtime
   against the loopback relay, and journal it.
2. FR-1 to FR-3 first (configure, test, create), then the mutant.
3. FR-4 to FR-7.
4. Docs, final campaign, one complete result.
5. After all slices archive: the reconciliation note (task 3.3).

## Risks

- If CI cannot run the real CLI, FR-3 proves less (FR-D1 (b)). The result
  must say so, never claim more.
- The fixture spec's runtime is the longest of the relay checks. It runs with
  `--workers=1` like its neighbors.
