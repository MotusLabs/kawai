# Design

Grounded in: `src/server/chat/catalogParse.ts` (trusted tiers, controlled
variables, credential-name fields), `profileCatalog.ts:229–245` (layering;
either user-level file replaces both shipped defaults whole),
`catalogMerge.ts` (per-key env merge `inherited < provider < model`,
`addCodexProfile` runtime-origin rules, `enforceTrustedCredentialInvariants`),
`chatProviderEnv.ts` (the effective env overlay on `process.env`;
withholding derived from the resolved catalog only), `routes/chatProviderEnv.ts`
(the Settings provider-env map: `current()` replaces the `AGENTBOARD_CHAT_ENV`
seed wholesale; values persist in `app_settings`; GET redacts by name regex
only), `ClaudeProfiles.ts` (launch composition, controlled-variable deletion,
credential injection, transport pinning), `chatAuth.ts` (creation-time auth
gate), `limitSignals.ts` (limit classes accepted on any status code),
`routing/workerEligibility.ts:198` and `routing/router.ts` (an empty worker
list substitutes the default profile; an unknown rule pick falls back to the
built-in rule), `groupCatalog.ts` (unknown worker keys dropped with warnings),
`ChatSessionManager.ts` (`resolveClaudeProfile` at creation),
`ChatSessionDriver.ts:825–870,1076–1089` (spawn-side launch settings; live
error emission), `config/providers.default.json` and
`config/profiles.default.json`, and `docs/claude-session-profiles.md`.

Root cause of the reported incidents, in code terms:

- **Precedence surprise**: a model's `env` overrides its provider's per key
  (`flattenModel`), and a legacy `profiles.json` entry is its own one-model
  provider; the shipped `mimo` entry carries its own `ANTHROPIC_BASE_URL`,
  so a relay URL configured "for MiMo" in another file lost to the entry's
  env. Nothing showed the winner.
- **No supported header path**: `validateEnv` refuses any env name outside
  `PROFILE_CONTROLLED_ENV`, so `ANTHROPIC_CUSTOM_HEADERS` is rejected with
  "not profile-controlled … never credentials" — correct about files, silent
  about alternatives.
- **Copy-to-override**: `profileCatalogLevels` drops both shipped defaults
  when either `~/.kawai` file exists, so adding `authTokenEnv` meant
  replicating the whole shipped catalog.
- **Late failure, wrong class**: creation gates only on credential presence
  (`chatAuth`, `profileCredential`); the first real request then fails with
  the gateway's text, and `limitSignals` (rightly) records no limit — but
  nothing classifies the failure either.
- **Credentials already live in SQLite**: the Settings provider-env map
  persists its values in `app_settings` (`routes/chatProviderEnv.ts`
  PUT → `db.setAppSetting`), every database backup copies them, and the GET
  redacts only names matching the secret-name pattern — a credential stored
  under any other name is served verbatim to the client.

## D1 — Credential store: one user-level file; SQLite retires as a credential source

**Choice.** Imported credential values live in `~/.kawai/credentials.json`
(`HOME`-resolved like the catalogs): a JSON object mapping environment
variable name → value, where per variable the value is a non-empty string
(**set**), an empty string (**blank** — the variable is exported empty at
launch, overriding lower sources, like a catalog env blank today), or absent
(**unset** — lower sources show through; the UI's Clear removes the key).
The module (`src/server/chat/credentialStore.ts`) creates the file with mode
0600, refuses to widen permissions on an existing file, refuses symlinks,
writes atomically (temp file in the same directory, fsync, rename), and
caches by an mtime/size stamp (`profileCatalogStamp`'s pattern) so per-launch
reads stay cheap. Concurrent saves serialize in-process; a failed save leaves
the previous file untouched and is reported. **Threat boundary, stated
honestly:** mode 0600 protects against other users on the host — it is not
isolation from tools running as the same user, which can read the file.
What keeps values from agents is that no launch receives them except inside
the two composed variables (D2), and no prompt, tool allowlist, or read API
exposes the store's contents or path semantics beyond presence and source.

**The store is the Settings provider-env map's new backing.** The whole map
retires from SQLite: the Settings env editor writes the store, and everything
the store holds composes into the launch environment per variable exactly as
the map did (`effectiveChatEnv`), so non-credential overrides an operator
kept there keep working. The write-only read rule applies to every store
entry: read surfaces show name, presence, and source — the old GET that
served non-secret-named values verbatim is gone.

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

**Upgrade migration (L-B).** At the first startup after this change, when the
Settings provider-env map (`app_settings`) is non-empty, its values move once
into the credential store and the map row is deleted — keyed by a recorded
migration stamp so a crash between the two writes retries instead of
duplicating or dropping. From then on no credential value is written to
SQLite again. **Honest scope:** database backups taken *before* the upgrade
still contain the old map values; nothing retroactively scrubs them, and a
backup restored later would bring the map back (the migration re-runs on it).
`docs/claude-session-profiles.md` states this and advises rotating any
pre-upgrade credential whose presence in old backups matters.

**Composed credential environment (after migration).** Per variable, exactly
one winner — the last source holding it:

| Order | Source | Semantics |
| --- | --- | --- |
| 1 | server process environment | today's ambient env |
| 2 | `AGENTBOARD_CHAT_ENV` seed | the process-env map the Settings route used to replace wholesale (`routes/chatProviderEnv.ts:39–43`); it now composes **per variable** as its own listed source |
| 3 | credential store | set overrides; blank exports empty; unset shows through |

Injection (`ANTHROPIC_AUTH_TOKEN`), the creation-time auth gate, withholding,
and provider usage pulls read this composed environment (`effectiveChatEnv`
gains the seed and store layers), so the gate and the spawn cannot disagree.
The source listing shows every source present per variable and warns when
more than one holds the same variable. The old wholesale-replacement
semantics (`current()` returning override-or-seed) is retired with the
override.

## D2 — Custom headers: names in the catalog, values from credential variables

**Choice.** A provider in a **trusted** `providers.json` (shipped or user
level) may set `headers`: a map of HTTP header name → credential variable
name, e.g. `{"x-bf-vk": "RELAY_VIRTUAL_KEY"}`. Rules:

- Header names must match a header-field-name token; variable names must
  match the existing `CREDENTIAL_NAME_PATTERN`. Two bindings whose names
  collide case-insensitively are refused at parse (HTTP field names are
  case-insensitive; one canonical winner would be a silent surprise).
- Trusted tier only, like `authTokenEnv`: the field is refused in project
  files and in any `profiles.json`, naming the file — a project file binding
  a credential variable into a header chooses where a server secret is sent.
- Every header variable is **registered**: it joins the secret-name registry
  (below), so no agent receives it under its own name — including when the
  entry is later disabled, removed, or exists only as a template.
- At launch, the provider's resolvable headers compose into
  `ANTHROPIC_CUSTOM_HEADERS` as newline-separated `Name: Value` pairs — the
  format the Claude Code CLI documents (code.claude.com/docs/en/env-vars,
  `ANTHROPIC_CUSTOM_HEADERS` row) and its parser confirms: split at the
  **first** colon, name and value whitespace-trimmed, CRLF also accepted;
  needs CLI v2.1.227+, inside our 2.1.289 baseline; a name or value with a
  character an HTTP header cannot carry fails the request, the error naming
  the pair by position. Kawai refuses to compose a pair whose resolved
  **value** contains CR, LF, or NUL — a value could otherwise synthesize
  another header — as a validation diagnostic naming the header, never the
  value; the connection test surfaces it as its own evidence class. The
  composed variable is set in the process environment only, never in the
  flag settings layer, exactly like the auth token today.
- A variable that resolves empty omits its header; the preview marks it
  missing, and the connection test reports the gap (D9). Creation is **not**
  gated on header variables (alternative considered and rejected: a creation
  gate for a relay that legitimately permits header-less models turns config
  into a lockout; the diagnostics cover the failure with an actionable name).
- A provider with `headers` but no `authTokenEnv` is **credential-bearing**
  for the trusted invariants (extending `providerCredentialed`): it requires
  a non-empty trusted base URL and takes no executable, and such launches pin
  the base URL and transport variables like credentialed ones do.

**Exposure boundary (stated honestly, per L-E).** The composed
`ANTHROPIC_CUSTOM_HEADERS` value and the auth token live in the CLI process's
environment; any child the CLI or its tools spawn can read that environment
unless something removes it, and kawai performs no scrub of the CLI's
environment. The guarantees are: (a) **omission** — every registered secret
name (below) is withheld from every agent launch under its own name; (b)
**composition** — the values reach the CLI only inside the two composed
variables, which is exactly today's token delivery mechanism; (c) **the flag
settings layer never carries a token or header value**. What a Bash child
actually sees on the supported CLI is established by the sentinel-only
fixture test (D12); until that evidence exists this design claims **parity
of mechanism** with the token path, not parity of measured exposure.

**Secret-name registry.** Withholding can no longer derive only from the
resolved catalog (`withheldCredentialNames` reads resolved entries, so
removing or disabling an entry un-hides its variables — `chatProviderEnv.ts:
95–112`). The withheld set becomes the union of: every credential variable
named at **any** catalog layer (parsed before `enabled` filtering, so a
disabled entry's names stay withheld), every header variable, every store
key, and the **retained names** — every name ever registered, persisted in
an `app_settings` key (names only, never values; names are not secrets).
Removing a provider entry, disabling an id, or clearing a header binding
never stops withholding its names; a remove-provider or remove-binding
oracle test pins this (P7).

**Alternatives:** values inline in catalog files — refused forever
(credential values never enter files); per-model headers — a header binds to
the relay account, not the model; a free-form env entry — that is the
rejected `ANTHROPIC_CUSTOM_HEADERS` path that started this.

## D3 — Small overrides: the user level merges over the shipped defaults

**Choice.** `profileCatalogLevels` always reads the shipped defaults (files,
or the embedded copies when missing) as tier 0 and the user level, when
either of its files exists, as tier 1 above them; project files keep their
tiers. Same-id entries merge per field as they already merge across project
levels (nearer wins per env key, empty neutralizes, scalars nearest-set-wins)
— with the existing trust refusals applying **before** any merge: a project
file may overlay labels and model mappings on a non-credentialed id, but a
project file touching a **credential-bearing** id (now including
headers-only providers) is rejected whole exactly as today
(`enforceTrustedCredentialInvariants` and the trusted-tier checks;
`catalogMerge.ts:175–184, 379–426, 430–437`) — it cannot override a
credentialed base URL, re-home its model, or bind headers.

**Disable is a trusted tombstone.** `enabled: false` on a **user-level**
entry removes the id from the resolved catalog — the provider entry, every
model key that resolves to that provider, and any Codex profile of that id —
and leaves a tombstone that **nearer tiers cannot resurrect**: a project file
re-defining the id (with or without `enabled`) resolves nothing for that id
while the tombstone stands, because the project tier sits below the user
tier's explicit removal. The advisor's point taken: rejecting `enabled`
below the user level alone proves nothing — a project file can re-define the
id without naming `enabled` at all — so the tombstone's suppression, not the
field refusal, is what blocks resurrection. A user-level entry for the same
id **without** `enabled: false` (a same-or-nearer trusted statement)
replaces the tombstone. Suppression also covers the implicit-default
synthesis path (`catalogMerge.ts` `finish()`): a tombstoned id cannot
reappear through synthesis. A model id re-homed under a *different*
provider id is a different id and resolves normally unless that id is itself
tombstoned. `enabled` below the user level is still rejected whole, naming
the file.

**Fixture honesty for the layering table.** After D4 the only shipped
provider is `claude`; layering rows use ids that actually remain shipped
(`claude`, `openai`) or are explicitly labeled synthetic (a `zai` fixture
stands for any user-defined or adopted id, since `zai` ships only in
templates).

**Regression oracle.** An instance whose user-level files already define
every id they care about (today's forced full copy) resolves to the same
effective catalog under merge as under the old replace rule **for every
non-runtime field**: ids, labels, env per key. The runtime-origin rules are
the one exclusion (P3): under replace, a user-level Codex entry could
convert a model key because the shipped files had vanished; under merge the
shipped Claude origin sits beneath and `addCodexProfile` refuses the
conversion (`catalogMerge.ts:451–458`) — that refusal is the documented
runtime-origin behavior, tested as its own case, not smoothed over.

## D4 — Shipped catalog trimmed to Anthropic and OpenAI (Codex); templates

**Choice.** `config/providers.default.json` keeps only the `claude` provider
(Default, Opus, Sonnet, Haiku — host claude.ai login / global credentials).
`config/profiles.default.json` is replaced by one entry, `openai`:
`runtime: "codex"`, label "OpenAI (Codex)", no pinned model (the Codex
app-server default), default Codex home — the shipped Codex path exists only
through user catalogs today, and this gives a fresh instance a working
non-Claude provider without credentials in kawai's control. The removed
entries — `zai` (glm, glm-flash), `minimax`, `mimo`, `kimi`, `openrouter`
(openrouter-opus/sonnet/haiku/deepseek-flash/minimax-flash) — ship verbatim
in a new `config/provider-templates.json`, each with the credential variables
to import (`ZAI_API_KEY`, `MINIMAX_API_KEY`, `MIMO_API_KEY`, `KIMI_API_KEY`,
`OPENROUTER_API_KEY` + `OPENROUTER_MANAGEMENT_KEY`). Public provider
endpoints stay as they are today in the shipped files; nothing private enters
the repository. The setup surface (D7) offers each template for adoption:
writing the entry into the user-level catalog unchanged (ids preserved) and
importing the credential values into the store (D1).

**Upgrade adoption (L-A) — existing installs keep working with no operator
action.** Manual template adoption alone is not a migration: it would break
this team's `glm-flash`/`mimo`/`openrouter-*` workers at upgrade. So at
startup kawai adopts removed shipped ids automatically: for each template id,
if a **reference** exists and **no catalog layer** (user or project) defines
that id, the template entry is written once, verbatim, into the user-level
catalog (creating the file if needed). References are: a non-killed stored
session's `profile_id`; a group file's `workers`/`profiles` list, `profile`
field, or `modelEffort`/`profileEffort` key naming it (bare or
`provider/model`-qualified); a routing rule pick; queued mail's
`workerChoice` or `allowedProfiles`. An adopted entry is marked **"adopted
at upgrade"** in the source listing and named in the server log. Adoption is
once per id per install (a durable stamp): the operator's later removal of
an adopted entry wins and is never re-adopted; a session created on the id
later is served by the normal unknown-profile degrade, which names the
template. Credential values are **not** imported by adoption — an adopted
entry surfaces its missing variables through the normal diagnostics.

**No default fallback (L-A).** A worker list that resolves to nothing never
substitutes the default profile: `workerEligibility.ts:198`'s
`profiles.length > 0 ? profiles : [DEFAULT_PROFILE_ID]` fallback is removed,
and the router's worker-choice resolution against an empty list narrows to
nothing instead of defaulting. Group mail whose group has no defined worker
waits with a named reason ("no defined worker for group …; profile(s) … are
not in the catalog") and the group shows a warning — it does not silently
run on `default`. With adoption in place this state is transient (the
referenced ids come back at startup); it is reachable only when an operator
explicitly disables or removes an id that is still referenced — then the
wait is the honest signal.

**Degrade before adoption is unreachable in practice, but specified:** a
stored session on an unknown id stays visible and blocks sending with the
restore message naming the template; unknown group worker keys are warned
and dropped (`groupCatalog.ts:125–159`) — both paths keep today's shape for
ids with no template (a hand-typed id never existed shipped).

**Migration test (required by the direction).** (a) A fresh instance with no
references resolves exactly Anthropic + OpenAI. (b) An upgraded instance
with a stored session on `mimo` and a group naming `glm-flash` adopts both
templates at startup — the session resumes, the group's workers spawn, the
listing marks both "adopted at upgrade". (c) After the operator disables an
adopted id, it stays gone and referenced mail waits with the named
no-worker reason instead of falling back to `default`. (d) Adopting the
`openrouter` template manually (after removal) restores its ids exactly as
the shipped entry behaved.

**Alternatives:** keep the entries but hide them — the picker stays noisy and
the trim's purpose (a fresh instance shows only what works out of the box)
fails; drop removed ids entirely — breaks this team's own workers and every
stored session; manual adoption only — every existing install breaks at
upgrade until a human edits JSON, which is the behavior being removed;
temporary fallback routing to `default` — silently runs team work on the
host login, the failure mode L-A rejects.

## D5 — One precedence table

Every field resolves through one table; the setup surface renders it and
warns on conflicts (a nearer layer overriding a value set at a layer the
setup edits, when the two differ).

| Field | Far → near (winner last) | Notes |
| --- | --- | --- |
| Catalog entry fields — label, model, env (per key), executable, limitResetTimeZone, authTokenEnv, balanceKeyEnv, headers | shipped < user < project | per field and per env key; trust refusals (D3) apply before merge for credential-bearing ids |
| Catalog runtime keys — `runtime`, `codexHome`, `network` | **runtime-origin rules, not nearest-wins**: a nearer file cannot flip a runtime a farther tier fixed (`addCodexProfile` ignores the nearer entry with that file's error); `codexHome`/`network` arrive only from trusted files; the same-tier release rule applies | `catalogMerge.ts:451–479` |
| Credential values | process env < `AGENTBOARD_CHAT_ENV` seed < credential store | per variable (D1); Settings is no longer a source; conflicts warn naming the sources |
| Launch env | see the branch table below | pinning is existing behavior (openrouter-provider D3), extended to headers-only providers |
| Model ID sent | startup `model` option; else `ANTHROPIC_MODEL`; tier aliases resolved through `ANTHROPIC_DEFAULT_*_MODEL` | the wire ID is the post-alias string the CLI actually sends (D10); env keys compose `inherited < provider < model` (`flattenModel`) |

**Launch-env branches** (`ClaudeProfiles.ts:157–185`), so no row overstates a
branch that does not apply:

| Branch | Composition |
| --- | --- |
| No overrides, no catalog entry | SDK `env` option omitted; the CLI inherits the server process env unchanged |
| Named profile, no credentials/headers | composed env (process env + seed + store) overlaid; every controlled variable **deleted** from the composed env; absent catalog keys blanked in the flag settings layer |
| Wrapper (`executable`) launch | the wrapper branch: the wrapper receives the composed env; a credential-bearing id can never take an executable (trusted invariant), so wrappers never carry tokens or headers |
| Credentialed or headers-only launch | branch above **plus** transport pins (base URL + `TRANSPORT_PIN_ENV`) in env and flag settings; `ANTHROPIC_AUTH_TOKEN` and composed `ANTHROPIC_CUSTOM_HEADERS` in env only |
| Codex runtime | no Claude env composition; `codexHome`/`network` from trusted tiers per the runtime-origin rules; credentials via the Codex login in its home |

Unreachable combination: a project file setting `authTokenEnv`,
`balanceKeyEnv`, `headers`, `enabled`, or `executable` never contributes —
the file is rejected whole (existing refusals, plus `enabled` and `headers`).

## D6 — Effective-configuration preview before creation

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

## D7 — Configuration sources listed; rejections name the supported setting

**Choice.** The profiles endpoint's payload grows a structured source
listing: every catalog file the resolution walks (shipped/embedded, user,
project), each with its status — loaded, missing, rejected with the full
reason — and, for rejections, the supported setting to use instead
(`ANTHROPIC_CUSTOM_HEADERS is not allowed in catalog files; bind header names
to credential variables with "headers" in a user-level providers.json, and
import its value in Settings → Credentials`). Credential sources are listed
per variable of the composed environment (D1's three sources), each with its
presence and origin. Entries adopted at upgrade (D4) are marked **"adopted
at upgrade"**, so an operator can see why an id they never configured is
offered. The New Session dialog and Settings render the listing prominently
(a visible panel, not a console log): catalog errors already block nothing
today, which is exactly why they must be loud.

**Alternatives:** only toast on failure — the human's report is that these
failures were invisible until a session failed; log-only — operators do not
tail agentboard.log to configure a relay.

## D8 — Connection test through the real launch path (Claude runtime, v1)

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

**Alternatives:** raw HTTP `POST /v1/messages` composed from the env —
faster, but it bypasses the executable, which is exactly where the reported
failures lived; a full SDK session — exercises more plumbing at the cost of
a persisted session per test; an availability probe — explicitly not a
gateway connectivity check today, and extending it would change its meaning
for every profile.

## D9 — Failure classes: one ordered, disjoint classifier; limits run first

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

**Rule 1 — credential resolution.** No token variable, no header variable,
and no other credential source resolves → `missing-credential` (creation
refusal, today's message). A host-login profile (no credential fields at
all) is tested with its login and its row notes that only the login could be
exercised.

**Rule 2 — the request outcome decides, list evidence qualifies.** A model
list result **never proves or disproves inference authentication** (L-C):
endpoints may allow anonymous listing, use different middleware, or enforce
different scopes — so every class below states its *evidence*, and the
display wording is "evidence: …", never "proves". Request success wins over
any list state; request failure consults the list only to qualify the
refusal.

| Request outcome | List state | Class | Evidence shown |
| --- | --- | --- | --- |
| ok (model reply) | * | `success` | list unavailable → note "catalog unverifiable"; list ok but startup ID absent → note "the provider's list lacks the model ID" (stale/wrong catalog — never a failure) |
| timeout (bounded) | * | `timeout` | the bound that fired |
| connect / TLS / DNS error | * | `network-failure` | the transport error text (redacted) |
| 404 / model-not-found | * | `model-catalog-failure` | the relay's refusal; list state noted |
| 401/403, no limit class | list ok | `virtual-key-restriction` | "the relay served its model list with the same credentials but refused this request" |
| 401/403, no limit class | list auth failure | `gateway-auth-failure` | "the relay refused both its model list and this request" |
| 401/403, no limit class | list unavailable | `auth-unknown` | evidence-qualified unknown: cannot distinguish an invalid key from a scoped refusal |
| 5xx / malformed / non-JSON | * | `relay-error` | the raw failure shape (redacted) |
| cancelled before an outcome | * | `cancelled` | — |

Header-variable gaps are reported beside any class: a class observed while a
bound header variable resolves empty carries "header \<name\>: variable
\<VAR\> is not set".

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

## D10 — Model availability checked against the provider's catalog

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

## D11 — Composition with `openrouter-provider` (active, 19/20)

This change builds on that change's landed deltas (`authTokenEnv`,
`balanceKeyEnv`, withholding, base-URL pinning, the `credit` window) and
**REMOVEs** its ADDED requirement "The shipped catalog includes OpenRouter"
(the shipped `openrouter` provider moves into the templates verbatim, ids
preserved). **Archive order: `openrouter-provider` first, then this
change**; the REMOVED block is authored against that requirement's final
text and re-checked at rebase before this change archives. If it stalls
before archiving, this change's spec work pauses on that one delta (the
rest is independent of it) rather than emitting a REMOVED against text that
does not exist yet. This change does not modify its credit-limit,
usage-pull, or cost-display deltas; `limitSignals`' table is untouched
(D9).

## D12 — Implementation proof obligations (advisory unresolved risks)

Each obligation names the design claim it is the evidence for; tasks.md
assigns each to a task.

1. **Sentinel-only CLI fixture** (D2's exposure boundary, P1): a fixture
   relay and sentinel secret values establish what the CLI process env
   holds, what a Bash tool child sees on the supported CLI baseline (the
   withheld names absent; only the two composed variables present), and
   that the flag settings layer carries no token or header value. Recorded
   as an e2e assertion; until it runs, the design claims parity of
   mechanism, not measured exposure.
2. **Credential-store IO** (D1): atomic write (temp + fsync + rename),
   symlink refusal, permission pin, concurrent-save serialization, and the
   crash-safe migration (stamp recorded in the same transaction as the
   move, retried on a later start; a restored pre-upgrade backup re-runs
   it).
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

## Acceptance oracles

Decision tables: D5's precedence table, D9's ordered classifier, and the
layering table below. Properties P1–P7 pin the invariants. Every row gets
an oracle id (`L#`, `D#` for D9 rows, `P#`) that tasks.md cites; each
executable form runs as a table-driven test next to the code it covers.

### Layering table (D3/D4)

| # | Id | User-level entry | Project entry | Resolved |
| --- | --- | --- | --- | --- |
| L1 | `claude` (shipped, non-credentialed) | none | none | present, shipped settings |
| L2 | `claude` | `enabled: false` | * | absent — trusted tombstone |
| L3 | `claude` | overrides base URL | none | present, user base URL, shipped siblings intact |
| L4 | `claude` | none | overrides base URL | present, project base URL for that project path — **non-credentialed ids only**; a credential-bearing (incl. headers-only) id rejects the project file whole instead, per D3 |
| L5 | `claude` | `enabled: false` | re-defines `claude` (no `enabled` key) | still absent for that project path — the tombstone suppresses nearer tiers; a project file can neither set `enabled` (rejected whole) nor resurrect the id |
| L6 | none (new id `relay`) | defines `relay` | none | present as user provider |
| L7 | `claude` | defines `claude` complete (non-runtime fields) | none | identical resolved settings to today's replace semantics (P3); runtime-origin placements are excluded and covered by their own runtime-origin test (D3) |
| L8 | `claude` | sets only `headers` | none | `claude` gains headers; base URL, models, env inherited (fixture synthetic: `claude` plus headers makes it headers-only credentialed — requires a trusted base URL in the entry) |
| L9 | `mimo` (template id, post-trim) | referenced by a stored session, no layer defines it | none | adopted once at startup from the template; resolves again; listing marks "adopted at upgrade"; operator removal then wins (D4) |

L5's mechanism is the tombstone's suppression, not the `enabled` field
refusal alone: a project file re-defining the id without naming `enabled`
resolves nothing while the tombstone stands (D3).

### Properties

- **P1 — Credential secrecy.** No credential value (store value, token,
  header value, balance key) appears in any HTTP response body, log line,
  wire-log frame, SQLite row, flag settings layer, or client payload —
  including the retired Settings path (post-migration, `app_settings`
  gains no new values); the only agent-visible forms are
  `ANTHROPIC_AUTH_TOKEN` and the composed `ANTHROPIC_CUSTOM_HEADERS`
  (mechanism parity with today's token path; measured exposure is the
  sentinel fixture's, D12). Redaction of exact values is tested with
  unshaped sentinels, split chunks, and overlapping values, not only the
  shape patterns. Generator: seeded run over random secret shapes; seams:
  the store module, the preview/listing projector, the classifier's
  redactor, the launch composer. Fixed seed, 200 cases, no new dependency.
- **P2 — Write-only store UI.** After any import/replace/blank/clear
  sequence, every read surface returns presence, source, and name only —
  never the value or a prefix, whatever the variable is named (the old
  name-regex hole is closed). Generator: random operation sequences; seam:
  the Settings/projector read paths.
- **P3 — Merge regression (non-runtime).** For any user-level catalog that
  defines every shipped id completely with no Codex runtime conversion in
  play, the resolved catalog equals the old replace-semantics catalog (ids,
  labels, env per key). Excluded and separately tested: runtime-origin
  placements — a nearer Codex entry over a farther-tier Claude origin is
  refused under merge per the runtime-origin rules (`addCodexProfile`),
  where replace silently allowed the conversion; the refusal is the
  documented behavior, asserted as its own case, and P3's generator
  excludes it. Generator: shipped catalog × complete overlays with field
  mutations, including removed-field/negative-space cases; seam:
  `resolveProfileCatalog` with injected homes. Fixed seed, 100 cases.
- **P4 — Limits first, diagnostics disjoint.** Every diagnostic class (D9
  rules 1–3) records no limit event, no cooldown, no park/forward/release;
  every limit-shaped signal — 429, 402, and the three limit classes **on
  any status, 403-with-`rate_limit` included** — records exactly as today.
  Generator: every D9 row plus the limit-predicate table through the
  classifier and the limit path; seams: `connectionDiagnostics` +
  `limitSignals` unchanged outputs.
- **P5 — Preview equals launch.** For every profile and project path, each
  non-credential preview field equals the production launch composition's
  field — `resolveClaudeProfile` plus the driver-side spawn settings (cwd,
  settingSources, executable resolution); credential fields render names,
  presence, and source only. Generator: catalog fixtures × profiles; seam:
  the preview projector composed over the production resolution.
- **P6 — Trust does not descend.** A project-level file setting
  `enabled`, `headers`, `authTokenEnv`, or `balanceKeyEnv` is rejected
  whole with the file named; the rest of the catalog resolves; a
  headers-only provider counts as credential-bearing for these refusals
  and for the trusted invariants. Generator: each field × each project
  file position; seam: the catalog parsers.
- **P7 — Withholding survives removal.** Removing a provider entry,
  disabling an id, or clearing a header binding never stops withholding
  its registered secret names (all-layer catalog names ∪ header variables
  ∪ store keys ∪ retained names, names only in `app_settings`); no Claude
  or Codex launch receives a registered name under its own name. Generator:
  remove/disable/clear sequences with a probe launch; seams:
  the withheld-name set successor and the launch composer.

### Completeness claim (D9)

Axes: limit-predicate match (yes/no) × credential resolution (none /
host-login-only / resolved) × request outcome (ok / timeout / network /
404 / 401-or-403 / other-error / cancelled) × list outcome (ok-with-id /
ok-without-id / auth-failure / unavailable). The classifier is an ordered
rule list, so every combination maps to exactly one class by first match;
the previously ambiguous cells (list-unavailable with a 401/403 request,
list auth-failure with request success, list-lacks-id with request success)
land in `auth-unknown`, `success`, and `success`-with-note respectively by
rule, not by omission. Model-based tests run the classifier as the
reference over seeded evidence sequences, including a test-run timeout at
the process-kill boundary, a cached-list TTL expiry mid-test, and list
evidence from a superseded credential generation (never consulted).
