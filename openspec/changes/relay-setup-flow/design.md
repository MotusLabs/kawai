# Design

## Context

This slice implements `provider-relay-setup` §6–§10 on the current tree.
The basis is the umbrella's D6–D10 and D13, its D12 obligations 3, 4, 5, 7
and 8, P4, P5, and the D9 completeness claim, all copied verbatim into the
appendix. Two things changed since the umbrella was written:

1. `ChatSessionDriver.ts` is gone. Claude launches are composed by
   `src/server/chat/provider/claudeRuntimeLaunch.ts` and run by the in-tree
   `@motuslabs/agent-runtime` Claude driver. The limit predicate now lives in
   `packages/agent-runtime/src/usage/limits.ts`, re-exported by
   `src/server/chat/limitSignals.ts:15`. The appendix's
   `ChatSessionDriver.ts:825–870` reads `claudeRuntimeLaunch.ts`
   (`claudeSpawnLaunch` :73, `launchFields` :162-169), and its `:1076–1089`
   reads the runtime's error and limit events projected by
   `provider/runtimeEvents.ts:63-64`.
2. The install modes are held. Every install still runs "replace": once
   either user-level catalog file exists, it replaces both shipped files
   whole (`profileCatalog.ts:236-243`). The setup write path therefore has
   to make that effect explicit (SW5), and templates and retained defaults
   are out of scope.

Source pin: `f52963d0ab20d5ff9693fcd941e3c3f17970aa26`.

## Current inventory at f52963d0

- Profiles API: `src/server/routes/claudeProfiles.ts` (32 lines), `GET /`
  returns `claudeProfileCatalog(...)` (:17), mounted at `/api/chat/profiles`
  (`bootstrap.ts:423`). There is no source listing, preview endpoint, or
  catalog-edit route.
- Catalog files: `profileCatalog.ts:228-253` (levels; whole-file replace
  when a user file exists); stamps through `profileCatalogStamp`; the parsers
  are in `catalogParse.ts`.
- Launch composition: `ClaudeProfiles.ts` (`resolveClaudeProfile`),
  `provider/claudeRuntimeLaunch.ts:73-97` (`claudeSpawnLaunch`, env) and
  `:162-169` (`launchFields`: `settingSources: ['user','project','local']`).
- Creation gate and availability: `chatAuth.ts:34`;
  `ChatSessionManager.ts:3050-3067` (`probeAvailability`, cached per key,
  injectable `availabilityProbe` :270).
- Limits: `packages/agent-runtime/src/usage/limits.ts` (the predicate:
  429 / 402 `credit` / `rate_limit`, `billing_error`, `overloaded` on any
  status); `limitSignals.ts:15-26` (Kawai's `ChatLimitSignal`).
- Live errors: the package emits `{type:'error', error: AgentErrorInfo}`
  (`packages/agent-runtime/src/claude/session.ts:292,384`,
  `resultSettlement.ts:49`). `AgentErrorInfo` carries `category`, `message`
  and `code` only (`packages/agent-runtime/src/errors.ts:40-46`), with **no
  HTTP status or structured body**. Kawai projects it to `{type:'error',
  message}` (`provider/runtimeEvents.ts:63-64`).
- Redaction: `src/server/outbound/redact.ts` (shape-based).
- Client: `src/client/components/NewSessionModal.tsx` (853 lines, over the
  file-size rule; new UI goes in new components);
  `src/client/components/ChatProviderSettings.tsx` (replaced by
  `provider-credential-store`'s credential section).
- Existing e2e specs touching this surface: `tests/e2e/chat-profiles.spec.ts`,
  `tests/e2e/settings-provider.spec.ts`, `tests/e2e/new-session-defaults.spec.ts`
  (fixture-gated on `AGENTBOARD_CHAT_FIXTURE`).
- Absent: a models-list adapter, `connectionDiagnostics.ts`, a connection
  test module, and a catalog-edit API.

## Source partition (this slice's rows)

| Source item | Disposition |
| --- | --- |
| 6.1 catalog-edit API | group 1 |
| 6.2 provider editor + template adoption | group 1 (editor); **adoption → held** (templates come from held 5.1) |
| 7.1 source listing | group 2; install-mode label, "retained default" marks, damaged install-state record → **held** |
| 7.2 preview endpoint + dialog | group 2 |
| 7.3 P5 | group 2 |
| 7.4 rejection routing | group 2 |
| 8.1–8.5 connection test, lifecycle, purity, Codex scope, redaction | group 3 |
| 9.1 classifier, 9.2 P4, 9.3 live classification | group 4 (9.3 retargeted from `ChatSessionDriver` to the runtime error event + `runtimeEvents.ts`) |
| 10.1–10.3 models list, evidence table + cache, wire-ID comparison | group 5 |
| provider-setup "Relay setup configures a provider in one flow" | here, minus the template sentence; "Template adoption restores ids" → **held** |
| provider-setup "The setup write path is safe…" | here; "Adoption imports values only into the store" → **held**; new "A first save states what replace mode drops" (SW5) |
| provider-setup "Configuration sources are listed…" | here; "Retained entries are marked", "A damaged install-state record is named" → **held**; new "A launch-env collision is listed" (moved from the registry requirement) |
| provider-setup "The effective configuration is previewed…" | here, + "A missing header variable is marked" (moved from relay-headers' "Empty variable omits the header") |
| the other seven provider-setup requirements | here, verbatim |
| profile-limit-handling (2 requirements) | here, verbatim |
| claude-session-profiles "Profiles are marked when the provider's catalog lacks their model" | here, verbatim |
| D12 obligations 3, 4, 5, 7, 8 | groups 3, 5, 5, 3, 1 |

## Decisions

**F1 — Replace mode stays honest (SW5).** Until the held install modes
land, the first user-level save on an install without user files makes the
shipped catalog disappear for every id the new file does not define. The
editor computes that difference through the production resolution, shows it,
and writes only after the operator confirms. Alternatives rejected: (a)
copying the shipped catalog into the user file silently, which brings back
the copy-to-override problem without saying so; (b) blocking the write path
on the held lineage, which would hold every unheld group too. Offering an
explicit "include the current shipped entries" choice in that preview is a
local implementation option, provided the preview names what is copied.

**F2 — One resolution for preview, test, and launch.** The preview, the
connection test, and session creation call the same `resolveClaudeProfile`
plus `claudeSpawnLaunch`/`launchFields`. P5 compares their composed
structures, never re-implemented copies.

**F3 — Live evidence comes from the runtime event.** The classifier is pure
over evidence: limit signal, resolver gate, request outcome, structured
error fields, and list state. For live turns the evidence has to arrive on
the runtime's error event. If `AgentErrorInfo` lacks the HTTP status and the
structured `error.type`/`error.code`, this slice adds optional fields to
the in-tree package (`packages/agent-runtime/src/errors.ts` and the Claude
result paths), which is additive with no publication. The Kawai projection
attaches an optional `diagnostic` to the transcript error row. The limit
path is not touched: `usage/limits.ts` outputs stay byte-for-byte as today
(P4), and `codex-capacity-retry`, which also edits that file, serializes with
this group.

**F4 — The test path writes nothing.** The connection test calls the
classifier in "test" context: no limit event, cooldown, park, forward, or
release, and no row, wire log, or transcript. It holds results in memory
per profile and returns them only to the requesting client.

## Acceptance oracles

### Setup write path table SW (umbrella D13 oracles a–d, plus replace mode)

| Id | Input | Observable result |
| --- | --- | --- |
| SW1 | save with a malformed base URL, an unknown field, or a trust-violating placement | refused whole naming the field; file bytes unchanged |
| SW2 | two saves race; the second carries the stamp the first replaced | the second gets `conflict` with the current stamp; nothing partial lands |
| SW3 | crash between temp-file write and rename | the previous catalog keeps serving; no temp file is left beside the target after restart |
| SW4 | editor save with a token value and a header value | the catalog entry holds variable names only; the values are in the credential store only |
| SW5 | first save on an install with no user-level file | a preview lists every shipped id that would stop being offered; unconfirmed → nothing written; confirmed → file written and the listing shows replace in effect |
| SW6 | save into an existing user file | only the edited entry changes (other entries byte-preserved after re-serialization) |

### Listing and preview table LP

| Id | Input | Observable |
| --- | --- | --- |
| LP1 | project catalog file fails validation | listing names file + full reason beside the picker; the other files' profiles stay offered |
| LP2 | variable only the store provides | listed as set, source store |
| LP3 | migration skipped a legacy entry | listing shows the skip naming the variable |
| LP4 | launch-env collision | listing names the variable and the supported setting |
| LP5 | catalog sets `ANTHROPIC_CUSTOM_HEADERS` | message names the trusted `headers` field and the credential store |
| LP6 | any rejection | the picker shows the failure, not only surviving profiles |
| LP7 | nearer layer overrides a field set at another layer | preview shows the winning layer and warns |
| LP8 | any preview | no credential or header value anywhere in the payload |
| LP9 | bound header variable empty | preview marks the header missing; creation stays available |

### Connection test table CT

| Id | Input | Observable |
| --- | --- | --- |
| CT1 | any Claude profile | test argv/env/settings/executable/model equal creation's composed structures |
| CT2 | relay never answers | at 30 s the process group is killed and reaped; class `timeout` |
| CT3 | success | the process group is reaped; no session, transcript, wire log, or row |
| CT4 | 429 / 402 / limit class on any status | the result reports the limit class with the stated reset; no limit event, cooldown, or row |
| CT5 | second test for the same provider while one runs | `busy`, no queue |
| CT6 | Codex profile | "not supported"; the login check still runs |
| CT7 | headers-only profile, header variables set | no token gate; the request is made |
| CT8 | credentialed profile, token missing, header and host login resolve | preflight `missing-credential`; nothing spawns |
| CT9 | relay echoes a secret; spawn exception embeds env | every sink shows it redacted (exact-value + pattern, split chunks, overlaps) |

### Classifier table D9 (umbrella D9, rows given ids; first match wins)

| Id | Request outcome | Structured evidence | Class |
| --- | --- | --- | --- |
| D9-0 | limit predicate matches (429, 402, limit class on any status incl. 403 `rate_limit`) | * | limit (live: recorded as today; test: reported, nothing recorded) |
| D9-1 | preflight refusal: declared token missing (even with a resolving header and host login) | — | `missing-credential` |
| D9-2 | ok | — | `success` (list notes only) |
| D9-3 | timeout | — | `timeout` |
| D9-4 | connect / TLS / DNS error | — | `network-failure` |
| D9-5 | 404 / model-not-found | — | `model-catalog-failure` |
| D9-6 | 401/403, no limit class | documented key-refusal type | `gateway-auth-failure` |
| D9-7 | 401/403, no limit class | documented virtual-key type | `virtual-key-restriction` |
| D9-8 | 401/403, no limit class | none, prose, or unknown type | `auth-unknown` (list state as a note, never an upgrade) |
| D9-9 | 400/405/409/422, schema-valid | — | `relay-error` |
| D9-10 | 5xx / malformed / non-JSON | — | `relay-error` |
| D9-11 | header composition refused (CR/LF/NUL) | — | `header-config-error` |
| D9-12 | cancelled before an outcome | — | `cancelled` |

Completeness: the appendix's axis claim holds over this table. Every
combination matches exactly one row by first match. Model-based tests run
the table as the reference over seeded evidence sequences, including a
timeout at the process-kill boundary, cached-list TTL expiry mid-test, and
list evidence from a superseded credential generation (never consulted).

### Model availability table MA

| Id | Input | Observable |
| --- | --- | --- |
| MA1 | complete schema-valid list lacking the wire ID | picker marks "not in the provider's catalog" |
| MA2 | list unavailable (error, 3xx, timeout) | no mark; preview notes "catalog unavailable"; creation proceeds |
| MA3 | truncated, malformed, > 10 pages or > 10,000 ids, > 5 s | unknown; no mark |
| MA4 | tier alias through `ANTHROPIC_DEFAULT_SONNET_MODEL` | the checked ID is the resolved wire ID |
| MA5 | base URL with a path | queries `{base URL}/v1/models` with the path preserved |
| MA6 | store, header, or catalog change | cache entry invalidated |
| MA7 | same provider, different project layer | separate cache entries |

### Properties

- **P4 — Limits first, diagnostics disjoint, tests pure** (umbrella P4,
  appendix): every D9 row and the limit-predicate table through the
  classifier in both contexts. Seams: `connectionDiagnostics` plus the
  package `usage/limits.ts` with unchanged outputs. Fixed seed, 200 cases.
- **P5 — Preview equals launch** (umbrella P5): catalog fixtures × profiles
  × project paths. Every non-credential preview field equals the production
  launch composition. Fixed seed, 100 cases.
- **PR1 — Redaction before every sink:** seeded unshaped sentinels, split
  across chunk boundaries and overlapping, never reach a log line, wire
  frame, client payload, stderr echo, or result card. Fixed seed, 200 cases.
- **PT1 — Test purity:** seeded test outcomes (all D9 rows) leave the
  database row counts and the limit/cooldown state unchanged. Fixed seed,
  100 cases.

### Production-composition oracles

| Id | Path | Observable | Mutant it must kill |
| --- | --- | --- | --- |
| SFW1 | editor → catalog-edit route → user `providers.json` → `/api/chat/profiles` | the new provider is offered after save; values only in the store | route writes without the stamp check |
| SFW2 | preview route vs `ChatSessionManager` creation for the same profile/path | P5 equality on the real composed structures | preview builds its own env |
| SFW3 | connection test → real spawn helper → fake CLI executable on a loopback relay | argv/env equal creation's; reaped; no rows | the test path calls the live limit recorder |
| SFW4 | live session failed turn (fixture runtime emitting a 403 with documented type) → `runtimeEvents.ts` → transcript error row | the row carries `virtual-key-restriction`; no limit event | the diagnostic computed after emission or dropped by the projection |
| SFW5 | models adapter → availability cache → picker payload | MA1 mark appears; MA6 invalidation on a store change | cache keyed by provider id only |

## Implementation contract

### Acceptance
- A1: Every SW row holds through the real catalog-edit route and `profileCatalogLevels` (SFW1); SW5 never writes without a confirmed preview listing the dropped shipped ids.
- A2: Every LP row holds through the profiles/listing/preview routes and the New Session and Settings UI; P5 passes through SFW2.
- A3: Every CT row holds through the connection-test module and the real spawn helper with a fake CLI executable and a loopback relay (SFW3); PT1 and PR1 pass.
- A4: Every D9 row and the completeness model-based test pass; P4 passes; live failed turns carry the class on the transcript error row through the runtime error event and `runtimeEvents.ts` (SFW4), and `packages/agent-runtime/src/usage/limits.ts` outputs are unchanged for every limit-predicate row.
- A5: Every MA row holds through the models adapter and cache (SFW5), and the picker marks only on a complete valid list.
- A6: Every scenario of this change's three delta specs has a covering `@covers` test, and the documented structured-evidence table (umbrella 10.2) is committed with its source pinned at implementation time.

### Invariants
- I1: No connection test writes a database row, limit event, cooldown, wire log, transcript, or session.
- I2: No credential or header value appears in any preview, listing, test card, live error row, log line, or wire frame.
- I3: Live limit recording is unchanged: for every limit-predicate input the recorded signal equals the pre-change signal.
- I4: No setup save removes a shipped id from the resolved catalog without an operator-confirmed preview that names it.
- I5: `openspec/changes/provider-relay-setup/**` stays byte-identical; no held task changes; no template or retained-layer behavior ships.

### Scope
- `openspec/changes/relay-setup-flow/**`
- `src/server/routes/claudeProfiles.ts`
- `src/server/routes/catalogEdit.ts`
- `src/server/chat/catalogEdit.ts`
- `src/server/chat/catalogSources.ts`
- `src/server/chat/profilePreview.ts`
- `src/server/chat/connectionTest.ts`
- `src/server/chat/connectionDiagnostics.ts`
- `src/server/chat/connectionRedactor.ts`
- `src/server/chat/modelsList.ts`
- `src/server/chat/profileCatalog.ts`
- `src/server/chat/catalogParse.ts`
- `src/server/chat/ChatSessionManager.ts`
- `src/server/chat/provider/runtimeEvents.ts`
- `src/server/chat/provider/claudeRuntimeLaunch.ts`
- `src/server/bootstrap.ts`
- `src/shared/chat.ts`
- `src/shared/providerSetup.ts`
- `packages/agent-runtime/src/errors.ts`
- `packages/agent-runtime/src/claude/**`
- `packages/agent-runtime/__tests__/**`
- `src/client/components/NewSessionModal.tsx`
- `src/client/components/providerSetup/**`
- `src/client/components/settings/**`
- `src/client/components/chat/**`
- `src/client/__tests__/**`
- `src/server/__tests__/**`
- `tests/e2e/chat-profiles.spec.ts`
- `docs/claude-session-profiles.md`
- `docs/architecture/**`
- `openspec/specs/provider-setup/spec.md`
- `openspec/specs/profile-limit-handling/spec.md`
- `openspec/specs/claude-session-profiles/spec.md`

### Verification
- V1: Tables SW, LP, CT, D9, MA run verbatim as table-driven tests; P4, P5, PR1, PT1 run as seeded properties through `propertyCases`; the D9 completeness model-based test runs.
- V2: SFW1-SFW5 run through the production composition, and each named mutant fails its test.
- V3: Preserved workflows pass: the existing profile catalog, creation gate, availability probe, limit predicate (package and Kawai), runtime event projection, and New Session dialog tests, plus the fixture-gated `tests/e2e/chat-profiles.spec.ts` and `tests/e2e/new-session-defaults.spec.ts` in CI's fixture step.
- V4: Citation preflight zero unresolved; the clean committed head passes `bun run check --full-properties` (pinned Bun 1.4.3); `bun scripts/verify-result.ts` exits 0; the agent-runtime package tests run through `bun run test <files>`.
- V5: Browser checks run only through the CI fixture path or a disposable checkout, database, and spare port with CI's fixture setup; never `bun run test:e2e` and never live data.

### Excluded
- X1: Template adoption, the templates list, retained-default marks, retire, the install-state record and its damaged-record listing, install-mode labels and opt-in (held lineage task-c6bfbd04).
- X2: A Codex connection test (non-goal; CT6 keeps the login check).
- X3: OpenRouter-format and Bifrost-native model-list adapters.
- X4: Any package publication; Kawai consumes the in-tree package.
- X5: The fixture-relay end-to-end acceptance (`fixture-relay`).

## Execution checkpoints

1. **Design challenge** (one round) on F1 (SW5) and F3 (runtime evidence
   fields), before code.
2. **Group 1 production path:** SFW1 plus SW2's conflict, journaled before
   the editor UI.
3. **Group 2:** P5 through SFW2 before the dialog UI.
4. **Group 3 first path:** SFW3 success plus CT2 timeout, journaled before
   CT4–CT9.
5. **Group 4:** D9 table and completeness first; then SFW4 with one
   live-path failure. The package field change gets its own checkpoint note.
6. **Group 5:** SFW5 plus MA2.
7. **Final:** docs, preflight, certificate, one complete result.

## Dependencies and serialization

- **Correctness prerequisites:** `provider-credential-store` (store imports,
  credential presence, migration skips, collisions) and `relay-headers`
  (header bindings in the editor, preview, and D9-11).
- **Shared files:** `packages/agent-runtime/src/usage/limits.ts` and the
  Claude result paths with `codex-capacity-retry` (it is the logical-turn
  owner there), serialized, with this slice reading limits only. Also
  `ChatSessionManager.ts` with credential-store, mimo, and process
  observability; `NewSessionModal.tsx` with rename group 2 (client keys).
  These are serialization edges, not correctness prerequisites.
- **Downstream:** `fixture-relay`.
- **Archive:** creates the `provider-setup` main spec; adds to
  `profile-limit-handling` and `claude-session-profiles` (ADDED only).

## Risks

- Classifier evidence depends on relay documentation. The structured-evidence
  table is pinned at implementation time, and anything outside it is
  evidence of nothing.
- Fake-CLI tests prove composition, not the real CLI's request path. The
  `fixture-relay` slice adds the end-to-end evidence.

## Appendix — inherited text (verbatim from `provider-relay-setup/design.md` at f52963d0)

Copied unchanged for implementer context; the sections above decide scope.

### D6–D10 (lines 642-887; section headings demoted to ####, text unchanged)

#### D6 — Effective-configuration preview before creation

**Choice.** The New Session dialog shows, for the selected profile, the
configuration creation would apply: the provider and profile with each
edited field's layer of origin, the exact model ID per tier, credential
variable names with presence and source, header names with their variables'
presence, and the conflict warnings from D5. The data comes from a server
endpoint that resolves the profile **through the production resolution**
(`resolveClaudeProfile` / the same path `ChatSessionManager` uses at
creation), projects the result, and redacts: credential values and header
values never appear — names, presence, and source only.

**Oracle.** Preview equality: for every non-credential field, the preview
value equals the resolved launch configuration's value for the same project
path and profile id. A preview that diverges from creation is the bug class
this requirement exists to kill.

#### D7 — Configuration sources listed; rejections name the supported setting

**Choice.** The profiles endpoint's payload grows a structured source
listing: every catalog file the resolution walks (shipped/embedded, user,
project), each with its status — loaded, missing, rejected with the full
reason — and, for rejections, the supported setting to use instead
(`ANTHROPIC_CUSTOM_HEADERS is not allowed in catalog files; bind header names
to credential variables with "headers" in a user-level providers.json, and
import its value in Settings → Credentials`). Credential sources are listed
per variable of the composed environment (D1's three sources), each with its
presence and origin. Entries served by the retained-defaults layer (D4)
are marked **"retained default"**, so an operator can see why an id they
never configured is offered. The New Session dialog and Settings render the listing prominently
(a visible panel, not a console log): catalog errors already block nothing
today, which is exactly why they must be loud.

**Alternatives:** only toast on failure — the human's report is that these
failures were invisible until a session failed; log-only — operators do not
tail agentboard.log to configure a relay.

#### D8 — Connection test through the real launch path (Claude runtime, v1)

**Scope (L-D).** v1 covers **Claude-runtime profiles only**. A Codex profile
shows the test as *not supported* and keeps its existing login check as its
verification; making a Codex print-mode probe is a non-goal (proposal).

**Choice.** A per-profile test runs server-side, on demand from the setup
surface and the New Session dialog:

1. Resolve the profile through the **production resolution** — the same
   `resolveClaudeProfile` call creation uses — and then compose the **full
   spawn-side launch settings** the driver adds at creation
   (`ChatSessionDriver.ts:825–870`): project cwd, settingSources
   user/project/local, controlled-variable deletion, other-credential
   blanks, transport pins, and the resolved executable with its version
   baseline check. Reuse is the whole launch, not executable+env: any field
   the test composes differently from creation is a bug this design forbids
   (D6's oracle extends to these fields). Missing `authTokenEnv` values
   refuse before anything spawns, with today's message.
2. Check the relay's model list (D10) — evidence for the classifier (D9),
   never proof of authentication (D9's rule).
3. Make one minimal model request **through the resolved executable** in
   print mode with a one-line prompt ("Reply with the single word OK") and
   the resolved model, so the CLI's own request path — env, settings layer,
   header composition, model mapping — is exercised end to end. The spawn
   runs with the CLI's transcript persistence disabled (`--no-session-
   persistence`, print-mode-gated on the supported baseline; the SDK's
   `persistSession: false` equivalent) so "transient" does not depend on
   kawai merely not reading the CLI's own transcript files.

**Bounds and lifecycle.** The 30-second budget covers everything: model-list
fetch, spawn, request, cancellation, and cleanup. One test at a time per
provider; a second concurrent request is reported **busy** (no queue). The
process group is killed and reaped on **every** exit path — timeout, error,
cancel, and after success — never only on timeout. Captured output is
bounded (tail cap) before storage.

**Redaction before every sink.** The classifier's redactor holds the full
credential snapshot — every store value, the composed token, every composed
header value — and applies **exact-value redaction plus the existing
pattern-based redaction** (`outbound/redact.ts` is shape-based and cannot
remove an arbitrary known secret) before anything reaches a log line, wire
frame, client payload, stderr echo, non-JSON output fragment, spawn
exception message, or result card. Exact-value redaction must be safe across
stream chunks (values split across reads) — an implementation obligation
with its own tests (D12), covering unshaped sentinels, overlapping values,
and bounded buffers.

The test is **transient**: no session, no transcript, no wire log, no
database row; the result is held in memory per profile and delivered to the
asking client only, like activity and notices. Creation does **not** require
the test (the operator decides), but the dialog offers it beside the
preview.

**Purity (L-F).** The test writes **nothing**: no limit event, no cooldown,
no park/forward/release, no row of any kind. A limit-shaped test outcome —
HTTP 429, HTTP 402, or a limit error class on any status — is **reported as
the test's class** (the classifier's limit rows) with the reset time when
the response states one, and records nothing. Live-session limit recording
is unchanged (D9's rule 0); the two contexts never share a write path.

**Gates through the production resolver (L-E).** Every credential gate the
test applies is the **same resolver session creation uses**: a credentialed
profile's `authTokenEnv` must resolve through the composed environment
(store included) or the test refuses before anything spawns, with today's
message — an ambient host login or header value never substitutes for a
declared `authTokenEnv` (existing rule, unchanged). A headers-only profile
has no token gate: the test runs without one, and a missing header variable
is a diagnostic beside the class, not a refusal. A host-login profile is
tested with its login. The test invents no new gate decision.

**Alternatives:** raw HTTP `POST /v1/messages` composed from the env —
faster, but it bypasses the executable, which is exactly where the reported
failures lived; a full SDK session — exercises more plumbing at the cost of
a persisted session per test; an availability probe — explicitly not a
gateway connectivity check today, and extending it would change its meaning
for every profile.

#### D9 — Failure classes: one ordered, disjoint classifier; limits run first

The classifier (new `src/server/chat/connectionDiagnostics.ts`) is a single
ordered rule list — first match wins, so every evidence combination maps to
exactly one class and no two classes overlap (the advisor's F2/F7, F4/F7,
and unavailable-list ambiguities are resolved by rule, not by omission).

**Rule 0 — the limit predicate runs first and unchanged (L-C).**
`limitSignals`' existing table keeps every behavior: HTTP 429 of any class,
HTTP 402 (`credit`), and the `rate_limit` / `billing_error` / `overloaded`
error classes **on any status code** record a limit event and cool the
profile exactly as today. A 403 carrying a limit error class is a **limit**,
never a diagnostic — the diagnostics layer applies only to failures the
predicate does not treat as limits, which makes "diagnostics never change
limit handling" true by construction.

**Rule 1 — the production resolver's required-credential gate (B6).** The
class is what the resolver session creation uses decides, not a separate
global-OR: a profile the resolver refuses for a **missing required
credential** — a credentialed profile whose declared `authTokenEnv` does
not resolve through the composed environment (D8's gate), whatever else
resolves beside it: an ambient host login or a bound header value never
substitutes for the declared token — maps to `missing-credential` with
today's refusal message; on the test path it is the **preflight refusal**
outcome (nothing spawns). A **headers-only** profile (no `authTokenEnv`)
has no token gate; a **host-login** profile (no credential fields at all)
is tested with its login and its row notes that only the login could be
exercised. Counterexample pinned in the table: declared token missing while
a bound header resolves and a host login exists is still
`missing-credential` — the other credentials do not rescue the gate.

**Rule 2 — the request outcome decides; only documented structured evidence
names an auth class.** A model list result **never proves or disproves
inference authentication** (L-C): endpoints may allow anonymous listing, use
different middleware, or enforce different scopes. Evidence is **structured
only**: the adapter's documented-evidence table (D10) names, per supported
relay family, the structured response fields (`error.type` / `error.code`
values) the relay documents for each refusal kind; a response whose
structured fields match the table maps to its class; **prose text —
"Failed to authenticate" and the like — is never evidence**; anything else
(unsupported type values, prose-only bodies, no body) is the
evidence-qualified `auth-unknown`. The display wording is "evidence: …",
never "proves". Request success wins over any list state; request failure
consults the list only as a **note** beside the class.

| Request outcome | Structured evidence | Class | Evidence shown |
| --- | --- | --- | --- |
| preflight refusal — the resolver refuses the required credential (declared token missing, even with a resolving header and a host login) | — | `missing-credential` | the resolver's refusal, naming the variable |
| ok (model reply) | — | `success` | list unavailable → note "catalog unverifiable"; list ok but wire ID absent → note "the provider's list lacks the model ID" (never a failure) |
| timeout (bounded) | — | `timeout` | the bound that fired |
| connect / TLS / DNS error | — | `network-failure` | the transport error text (redacted) |
| 404 / model-not-found | — | `model-catalog-failure` | the relay's refusal; list state noted |
| 401/403, no limit class | documented type = key refusal | `gateway-auth-failure` | the matched documented type |
| 401/403, no limit class | documented type = virtual-key scope/quota refusal | `virtual-key-restriction` | the matched documented type |
| 401/403, no limit class | none (prose, unknown type, or empty body) | `auth-unknown` | evidence-qualified unknown; list state shown as a note ("the relay served its model list with these credentials") that never upgrades the class |
| other 4xx (400/405/409/422…), schema-valid response | — | `relay-error` | the response shape (redacted) |
| 5xx / malformed / non-JSON | — | `relay-error` | the raw failure shape (redacted) |
| header composition refused (CR/LF/NUL in a value) | — | `header-config-error` | the header's name, never its value |
| cancelled before an outcome | — | `cancelled` | — |

Header-variable gaps are reported beside any class: a class observed while a
bound header variable resolves empty carries "header \<name\>: variable
\<VAR\> is not set".

**Two write contexts (L-C, L-F).** The classifier is one pure function over
evidence; its callers differ only in side effects. The **live** driver path
records limits exactly as today (rule 0) and attaches the diagnostic
display-only. The **test** path records nothing anywhere; a limit-shaped
test outcome is reported as its class with the reset time when the response
states one (D8's purity).

**Live-session integration (advisory point 6, PROCEED).** The misleading 403
appeared during real use, not at setup — so the same classifier runs for
**every failed model turn in any live session**, not only the first turn and
not only the test: credentials and catalog permissions can change at any
point in a session's life, so each failure classifies fresh. The driver's
limit reporting already happens before error text is emitted
(`ChatSessionDriver.ts:1076–1089`, retries at 1297), so the diagnostic is
computed in the same failure handling — **before** emission — and attaches
an optional additive diagnostic field to the transcript error row (both the
assistant-message and `api_retry` signal shapes are handled and tested).
Classification is additive display: turn outcomes, mail outcomes, and
limits behave exactly as today (rule 0), and the connection test (D8)
shares the classifier so the setup card and the live row never disagree
about the same evidence. List evidence for a live classification is pinned
to the same credential generation and capture window as the launch (D10's
cache key) — a stale list from before a credential change is not evidence.

#### D10 — Model availability checked against the provider's catalog

**Adapter contract (v1): Anthropic-compatible.** For a provider with a
trusted base URL the server queries `GET {base URL}/v1/models` — a plain
string join that **preserves the configured path** (a base URL of
`https://relay.example.internal/anthropic` queries
`…/anthropic/v1/models`, Bifrost's Anthropic-compatible mount; the origin is
never substituted for the configured path). Auth headers are composed
exactly as the launch composes them (token as the CLI would send it, plus
the provider's custom headers). The accepted response schema is the
Anthropic models list (`{data: [{id, …}]}`); pagination follows `limit` /
`after_id` bounded at 10 pages and 10,000 ids within a 5-second budget; a
whole-request timeout applies. **Redirects are not followed** (a 3xx is
`unknown` — never chase a credential-bearing request across origins).
Malformed, partial, or truncated lists classify `unknown`. Only a complete,
schema-valid list establishes *absent* — "not yet seen" is never converted
into "unavailable". OpenRouter-format and Bifrost-native adapters are
non-goals for v1 (the shipped `openrouter` template keeps its own usage
adapter; this pull is separate from all usage adapters and does not touch
them).

**Cache.** The result caches per `(provider id, resolved project layer,
catalog stamp, credential-store stamp, server boot)` — a credential,
Settings-store, or header change invalidates it, not only a catalog edit —
with a 5-minute TTL and a 60-second negative cache so a relay blip does not
flap the picker.

**The exact wire model.** The comparison uses the model string **the launch
actually sends on the wire**: the startup option after CLI alias resolution
(a tier alias resolves through `ANTHROPIC_DEFAULT_*_MODEL`, which may carry
a context suffix like `[1m]`), not the raw startup label — the shipped
`openrouter` template's `sonnet` maps to a different wire ID today, which is
exactly the bug class this rule kills. The fixture e2e asserts the
relay-observed model ID equals the checked ID (D12). A successful list that
lacks the wire ID marks the profile "not in the provider's catalog" in the
picker and preview; a list that cannot be retrieved marks nothing
("catalog unavailable" in the preview only) — availability never blocks
creation.

**Alternatives:** probe by sending a model request — costs tokens and
cannot distinguish a scoped refusal from a catalog gap; check only on test —
the operator wants the mark while browsing profiles, before any test.


### D12 obligations 3, 4, 5, 7, 8 (lines 955-978)

3. **Connection-test lifecycle** (D8): end-to-end deadline, process-group
   kill and reap on every exit path, transcript-persistence disable,
   bounded output, and redaction-before-sink with split-chunk safety
   (unshaped sentinels, overlapping values, bounded buffers).
4. **Models-endpoint semantics** (D10): the v1 Anthropic-compatible adapter
   against the fixture relay (path-preserving URL, pagination termination,
   schema validation, redirect refusal, UNKNOWN classification), plus the
   wire-model equality assertion (relay-observed ID == checked ID).
5. **Credential-generation cache invalidation** (D10): store, header, and
   catalog changes each invalidate the availability cache; a bare provider
   id key does not survive across project layers.
6. **Migration crash/collision/restart table** (D1): the file-first
   ordering (store write durable before any SQLite write), absorption and
   collision behavior at each crash point, stamp idempotence, and the
   restored-pre-upgrade-backup re-run.
7. **Connection-test purity** (D8, L-F): a limit-shaped test outcome —
   429, 402, a limit class on any status — records no row anywhere and
   reports the class with the reset time when stated; the live path's
   limit recording is untouched (P4's test-context half).
8. **Setup write path** (D13): invalid-entry refusal naming the field with
   the file untouched; stale-stamp conflict with nothing partial landed;
   adoption writing ids verbatim and values only into the store; crash
   between temp-file write and rename leaving the previous catalog
   serving.

### D13 (lines 980-1002)

The setup flow's writes go through **one owned path** (one PR owns it, per
L-G/B8), never scattered file pokes: a catalog-edit API that validates
through the production parsers, saves the user-level catalog files
atomically (temp file in place, fsync, rename — the credential store's
discipline), detects concurrent edits (the request carries the catalog
stamp it read; a stamp mismatch is a **conflict** reported to the operator,
never a silent overwrite), and serves both the New Session/Settings
provider editor (create or overlay a provider entry: base URL, token
variable, header bindings, model IDs) and template adoption (write the
template entry verbatim into the user level; credential values go only
into the store). In replace-mode installs the editor states that saving
creates or extends the replace-mode files before the first save.

**Oracles.** (a) An invalid entry (bad URL shape, unknown field, a
trust-violating placement) refuses the write whole and names the field —
the file is untouched. (b) Two edits racing on one stale stamp: the loser
receives the conflict with the current stamp and nothing partial lands.
(c) Adoption writes entry ids verbatim and imports values only into the
store. (d) A crash between the temp-file write and the rename leaves the
previous catalog serving.


### P4 and P5 (lines 1217-1232)

- **P4 — Limits first, diagnostics disjoint, tests pure.** Every diagnostic
  class (D9 rules 1–2) records no limit event, no cooldown, no
  park/forward/release. In the **live** context every limit-shaped signal —
  429, 402, and the three limit classes **on any status,
  403-with-`rate_limit` included** — records exactly as today; in the
  **test** context a limit-shaped outcome records nothing anywhere and is
  reported as its class, with the reset time when the response states one.
  Generator: every D9 row plus the limit-predicate table through the
  classifier in both contexts; seams: `connectionDiagnostics` +
  `limitSignals` unchanged outputs.
- **P5 — Preview equals launch.** For every profile and project path, each
  non-credential preview field equals the production launch composition's
  field — `resolveClaudeProfile` plus the driver-side spawn settings (cwd,
  settingSources, executable resolution); credential fields render names,
  presence, and source only. Generator: catalog fixtures × profiles; seam:
  the preview projector composed over the production resolution.

### Completeness claim (lines 1251-1275)

Axes: limit-predicate match (yes/no) × write context (live / test) ×
credential gate (not required — host-login or headers-only / required and
resolved / required and missing despite a resolving header and a host login
— the counterexample / required and missing, nothing else) × request
outcome (preflight refusal / ok / timeout / network / 404 / 401-or-403 /
other-4xx / 5xx-or-malformed / header-composition-refused / cancelled) ×
structured evidence (none / documented key-refusal type / documented
virtual-key type) × list outcome (ok-with-id / ok-without-id / auth-failure
/ unavailable). The classifier is an ordered rule list, so every
combination maps to exactly one class by first match; the previously
ambiguous cells land by rule, not by omission: the required-credential
counterexample reads `missing-credential` before any request outcome
exists; prose-only or unmatched-evidence 401/403 reads `auth-unknown`
whatever the list says (an anonymous-list + invalid-token case included);
both-refused without a documented type reads `auth-unknown`; a schema-valid
400/405/409/422 reads `relay-error`; a refused header composition reads
`header-config-error`. The write-context axis decides side effects only:
live records limits per rule 0, test records nothing (P4's two halves).
Model-based tests run the classifier as the reference over seeded evidence
sequences, including a test-run timeout at the process-kill boundary, a
cached-list TTL expiry mid-test, and list evidence from a superseded
credential generation (never consulted).
