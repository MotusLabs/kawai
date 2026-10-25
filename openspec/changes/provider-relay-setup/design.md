# Design

Grounded in: `src/server/chat/catalogParse.ts` (trusted tiers, controlled
variables, credential-name fields), `profileCatalog.ts` (layering; the
user level replaces both shipped defaults when either file exists),
`catalogMerge.ts`, `chatProviderEnv.ts` (effective env, withholding),
`ClaudeProfiles.ts` (launch composition, credential injection, transport
pinning), `chatAuth.ts` (creation-time auth gate), `limitSignals.ts`
(limit classes), `openRouterUsage.ts` (the server-side provider pull
pattern), `ChatSessionManager.ts` (`resolveClaudeProfile` at creation),
`config/providers.default.json` and `config/profiles.default.json` (the
shipped entries), and `docs/claude-session-profiles.md`.

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

## D1 — Credential store: a user-level file, mode 0600, outside SQLite

**Choice.** Imported credential values live in `~/.kawai/credentials.json`
(`HOME`-resolved like the catalogs): a JSON object mapping environment
variable name → value. The module (`src/server/chat/credentialStore.ts`)
creates it with mode 0600, refuses to widen permissions on an existing file,
and caches by an mtime/size stamp (`profileCatalogStamp`'s pattern) so reads
per launch resolution stay cheap. Values are applied into the effective
chat environment between the process environment and the Settings provider
env:

    process env  <  credential store  <  Settings provider env  <  catalog env

so an imported value overrides the ambient server environment variable, and
a value typed in Settings still wins for its key (today's behavior preserved
for existing setups). `ANTHROPIC_AUTH_TOKEN` injection, the auth gate, and
withholding read the same composed environment (`chatAuth.effectiveChatEnv`
gains the store layer), so gate and spawn cannot disagree.

**Why not SQLite:** backups copy the database (`DatabaseBackups`); a
credential in a row lands in every snapshot and in `status()` listings. The
store file sits beside the catalogs, which backups never touch.

**Why not a project file:** `.kawai/` files are agent-writable; trust never
descends below the user level (existing rule, unchanged).

**Alternatives considered:** env-wins (store fills only missing variables) —
an import would silently do nothing while a stale container env var exists,
the exact debugging session this change ends; keyring/OS secret service — a
new host dependency kawai does not have today; SQLite with backups excluded —
fragile against the backup path growing.

**UI.** Settings gains a credential-import section: per variable name, set
or replace a value (masked input, never rendered back), clear it. Read
surfaces (the source listing, the preview) show name, presence, and source
(store / server env / Settings / absent) — never the value or a prefix.

**Effect without restart.** Launch resolution reads the store per stamp, like
catalog files; a save applies at the next spawn. Active processes keep their
environment (unchanged rule for Settings and catalogs).

## D2 — Custom headers: names in the catalog, values from credential variables

**Choice.** A provider in a **trusted** `providers.json` (shipped or user
level) may set `headers`: a map of HTTP header name → credential variable
name, e.g. `{"x-bf-vk": "RELAY_VIRTUAL_KEY"}`. Rules:

- Header names must match a header-field-name token; variable names must
  match the existing `CREDENTIAL_NAME_PATTERN`.
- Trusted tier only, like `authTokenEnv`: the field is refused in project
  files and in any `profiles.json`, naming the file — a project file binding
  a credential variable into a header chooses where a server secret is sent.
- Every header variable joins `withheldCredentialNames`' set: no agent
  receives it under its own name.
- At launch, the provider's resolvable headers compose into
  `ANTHROPIC_CUSTOM_HEADERS` as newline-separated `Name: Value` pairs — the
  format the Claude Code CLI documents (`Name: Value`, newline-separated for
  multiple; needs CLI v2.1.227+, inside our 2.1.289 baseline; a name or value
  with a character an HTTP header cannot carry fails the request, the error
  naming the pair by position — the connection test surfaces that as its own
  evidence) — set in the process environment only, never in the flag settings
  layer, exactly like the auth token today ("no more agent exposure than
  today's token path").
- A variable that resolves empty omits its header; the preview marks it
  missing, and the connection test reports the gap (D9). Creation is **not**
  gated on header variables (alternative considered and rejected: a creation
  gate for a relay that legitimately permits header-less models turns config
  into a lockout; the diagnostics cover the failure with an actionable name).
- A provider with `headers` but no `authTokenEnv` is valid only with a
  trusted base URL (same rule as credentialed providers: the header values'
  destination must be pinned); such launches pin the base URL and transport
  variables like credentialed ones do.

**Alternatives:** values inline in catalog files — refused forever
(credential values never enter files); per-model headers — a header binds to
the relay account, not the model; a free-form env entry — that is the
rejected `ANTHROPIC_CUSTOM_HEADERS` path that started this.

## D3 — Small overrides: the user level merges over the shipped defaults

**Choice.** `profileCatalogLevels` always reads the shipped defaults (files,
or the embedded copies when missing) as tier 0 and the user level, when
either of its files exists, as tier 1 above them; project files keep their
tiers. Same-id entries merge per field as they already merge across project
levels (nearer wins per env key, empty neutralizes, scalars nearest-set-wins).
A new **disable** field, `enabled: false`, on a user-level entry removes that
id from the resolved catalog entirely (shipped or not). `enabled` is
trusted-tier only: a project file setting it is rejected whole, naming the
file — project files are agent-writable and must not delete operator
configuration.

**Regression oracle.** An instance whose user-level files already define
every id they care about (today's forced full copy) resolves to the same
effective catalog under merge as under the old replace rule: every shipped
id the files replicate is overridden per field with identical values; every
shipped id the files *omit* now survives — that is the intended new
behavior, and the operator removes it with one `enabled: false` instead of
maintaining a copy.

**Alternatives:** status quo (replace) — the reported pain; a separate
override file per entry — more files, not fewer; JSON-null entry as disable —
today's parser rejects non-object entries, and one mechanism (`enabled:
false`) keeps validation messages precise.

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

**Why ids must be preserved:** stored sessions keep their `profile_id`;
group files and routing rules name profile ids (`profiles:` maps, `profile:`
fields). Adopting a template with the same ids restores resolution for all of
them with no migration. Until adoption, existing behavior degrades correctly:
unknown stored sessions stay visible and block sending with the restore
message; unknown ids in group `profiles:` maps are warned and dropped;
sessions on them keep their stored identity.

**Migration test (required by the direction).** A fresh instance resolves
exactly Anthropic + OpenAI; a stored session on `mimo` is visible, blocked,
and its message names the template; a group file naming `glm-flash` routes
nothing and warns; after adopting the `mimo` and `zai` templates the ids
resolve again, the stored session resumes, and the group's workers spawn.

**Alternatives:** keep the entries but hide them — the picker stays noisy and
the trim's purpose (a fresh instance shows only what works out of the box)
fails; drop removed ids entirely — breaks this team's own workers and every
stored session; templates as documentation snippets only — copying JSON by
hand is the behavior being removed.

## D5 — One precedence table

Every field resolves through one table; the setup surface renders it and
warns on conflicts (a nearer layer overriding a value set at a layer the
setup edits, when the two differ).

| Field | Far → near (winner last) | Notes |
| --- | --- | --- |
| Catalog entry fields (label, model, env, executable, limitResetTimeZone, runtime, codexHome, network, authTokenEnv, balanceKeyEnv, headers) | shipped < user < project | per env key and per field; `enabled: false` (trusted tiers only) removes the id |
| Credential values | process env < credential store < Settings provider env | shown per variable; conflict (store and env both set) warns naming both sources |
| Launch env | composed server env < catalog env (blanks neutralize) < pinned base URL + transport on key-carrying launches | pinning is existing behavior (openrouter-provider D3), now extended to `headers`-only providers |
| Model ID sent | startup `model` option; else `ANTHROPIC_MODEL`; tier aliases via `ANTHROPIC_DEFAULT_*_MODEL` | the preview lists the exact ID per tier |

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
per variable the resolved catalog names (D1). The New Session dialog and
Settings render the listing prominently (a visible panel, not a console
log): catalog errors already block nothing today, which is exactly why they
must be loud.

**Alternatives:** only toast on failure — the human's report is that these
failures were invisible until a session failed; log-only — operators do not
tail agentboard.log to configure a relay.

## D8 — Connection test through the real launch path

**Choice.** A per-profile test runs server-side, on demand from the setup
surface and the New Session dialog:

1. Resolve the profile through the **production resolution** — the same
   `resolveClaudeProfile` call creation uses (D6's equality oracle covers
   this composition). Missing `authTokenEnv` values refuse before anything
   spawns, with today's message.
2. Check the relay's model list (D10) — fast, and the evidence that
   distinguishes authentication from authorization (D9).
3. Make one minimal model request **through the resolved executable and
   environment**: spawn the executable the launch resolved (wrapper or
   standard binary, baseline-checked as at creation) in print mode with a
   one-line prompt ("Reply with the single word OK") and the resolved model,
   so the CLI's own request path — env, settings layer, header composition,
   model mapping — is exercised end to end. Bounded (30 s default): on
   timeout the process group is killed and the class is `timeout`.

The test is **transient**: it creates no session, writes no transcript, no
wire log, and no database row; its result is held in memory per profile and
delivered to the asking client only, like activity and notices. One test at
a time per provider; a second request waits or reports busy. Cost: one
minimal model request. Creation does **not** require the test (the operator
decides; the human acceptance is "verify each selected model", not "be
forced through a wizard"), but the dialog offers it beside the preview.

**Alternatives:** raw HTTP `POST /v1/messages` composed from the env —
faster, but it bypasses the executable, which is exactly where the reported
failures lived; a full SDK session — exercises more plumbing at the cost of
a persisted session per test; an availability probe — explicitly not a
gateway connectivity check today, and extending it would change its meaning
for every profile.

## D9 — Failure classes, distinguished by evidence, never limits

The classifier (new `src/server/chat/connectionDiagnostics.ts`) maps
observed evidence to one class. `limitSignals.ts` keeps its limit table
untouched: none of these classes records a `profile_limit_event`, cools a
profile, parks, forwards, or releases work. A limit-shaped signal (429, 402,
`rate_limit`/`billing_error`/`overloaded`) classifies as a limit exactly as
today — the diagnostic layer never swallows one.

| # | Token variable present | Model list result | Model request result | Class | Surface |
| --- | --- | --- | --- | --- | --- |
| F1 | no | * | * | `missing-credential` | creation refusal (today's message, naming provider and variable) |
| F2 | yes | auth failure (401/403) | * | `gateway-auth-failure` | test result card; live failure row |
| F3 | yes | ok | auth failure (401/403) | `virtual-key-restriction` (relay authenticated the key, refuses this resource) | test card; live row; preview hint |
| F4 | yes | ok, model absent | * | `model-catalog-failure` | picker mark; test card |
| F5 | yes | ok | 404 model-not-found | `model-catalog-failure` | picker mark; test card |
| F6 | yes | unavailable (no endpoint/404) | ok | `success` (catalog unverifiable — noted, not failed) | test card note |
| F7 | yes | * | ok | `success` | test card |
| F8 | yes | * | connect/TLS error | `network-failure` | test card; live row |
| F9 | yes | * | timeout (bounded) | `timeout` | test card; live row |

The distinguishing evidence between F2 and F3 is the **model list**: the
same credentials that fail a model request but succeed at the list prove the
relay authenticated the key and refused the resource — the reported
"Failed to authenticate" 403 that was not an authentication failure.
Header-variable gaps are reported beside any class: a class observed while a
bound header variable resolves empty carries "header <name>: variable
<VAR> is not set".

**Live-session integration.** The misleading 403 appeared during real use,
not at setup — so classification is **not** a first-turn or setup-only
feature: every failed model turn in any live session passes through the
same classifier, from the evidence the driver already has at the failure
point (the error class, the status parsed from the text as `limitSignals`
reads it, the message body, and the provider's cached model-list result
when one exists). The transcript error row then carries the class and its
guidance beside today's text, whichever turn failed — first turn, mid-work,
or after hours of use; a session that hit `gateway-auth-failure` after
working for a while reads exactly like one that never worked. The row
payload gains an optional additive diagnostic field; nothing else about the
turn changes. Classification is additive display: turn outcomes, mail
outcomes, and limits behave exactly as today, and the connection test (D8)
shares the classifier so the setup card and the live row never disagree
about the same evidence.

## D10 — Model availability checked against the provider's catalog

**Choice.** For a provider with a trusted base URL, the server queries the
relay's model list — `GET {base-url origin}/v1/models` with the provider's
effective token and composed headers (the OpenRouter host keeps its own
endpoints; this pull is separate from and does not touch the usage
adapters). Response cached per provider for a bounded TTL (5 minutes),
invalidated by the catalog stamp; failures cache negatively for a shorter
time (60 s) so a relay blip does not flap the picker. The comparison uses
the **exact startup model ID the launch sends** (D5's model-ID row) against
the listed IDs. A successful list that lacks the ID marks the profile
"not in the provider's catalog" in the picker and preview (F4); a list that
cannot be retrieved marks nothing ("catalog unavailable" in the preview
only) — availability must never block creation on a relay without a list
endpoint.

**Alternatives:** probe by sending a model request — costs tokens and
cannot distinguish F3 from F4; check only on test — the operator wants the
mark while browsing profiles, before any test.

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

## Acceptance oracles

Decision tables: D5's precedence table, D9's failure-class table (F1–F9),
and the layering table below. Properties P1–P6 pin the invariants. Every
row gets an oracle id (`L#`, `F#`, `P#`) that tasks.md cites; each
executable form runs as a table-driven test next to the code it covers.

### Layering table (D3/D4)

| # | Shipped id | User-level entry | Project entry | Resolved |
| --- | --- | --- | --- | --- |
| L1 | `zai` | none | none | present, shipped settings |
| L2 | `zai` | `enabled: false` | * | absent |
| L3 | `zai` | overrides base URL | none | present, user base URL, shipped siblings intact |
| L4 | `zai` | none | overrides base URL | present, project base URL for that project path |
| L5 | `zai` | `enabled: false` | re-defines `zai` | absent for that project path; file with `enabled` rejected below user level, so project re-definition cannot resurrect (unreachable below user level) |
| L6 | none (new id `relay`) | defines `relay` | none | present as user provider |
| L7 | `zai` | defines `zai` complete (all fields) | none | identical resolved settings to today's replace semantics (P3) |
| L8 | `zai` | sets only `headers` | none | `zai` gains headers; base URL, models, env inherited from shipped |

L5's project branch is unreachable by validation: `enabled` is refused
below the user level (the project file is rejected whole), so the row
records the reason rather than an outcome.

### Properties

- **P1 — Credential secrecy.** No credential value (store value, token,
  header value, balance key) appears in any HTTP response body, log line,
  wire-log frame, SQLite row, flag settings layer, or client payload; the
  only agent-visible forms are `ANTHROPIC_AUTH_TOKEN` and the composed
  `ANTHROPIC_CUSTOM_HEADERS` (today's token path). Generator: seeded run
  over random secret shapes; seams: the store module, the preview/listing
  projector, the test-result classifier, the launch composer. Fixed seed,
  200 cases, no new dependency.
- **P2 — Write-only store UI.** After any import/replace/clear sequence,
  every read surface returns presence, source, and name only — never the
  value or a prefix. Generator: random operation sequences; seam: the
  Settings/projector read paths.
- **P3 — Merge regression.** For any user-level catalog that defines every
  shipped id completely, the resolved catalog equals the old
  replace-semantics catalog (ids, labels, env per key). Generator: shipped
  catalog × complete overlays with field mutations; seam:
  `resolveProfileCatalog` with injected homes. Fixed seed, 100 cases.
- **P4 — Diagnostics are not limits.** Every F2–F9 class records no limit
  event, no cooldown, no park/forward/release; every limit-shaped signal
  (429, 402, the three classes) still records exactly as today. Generator:
  each table row through the classifier and the limit path; seam:
  `connectionDiagnostics` + `limitSignals` unchanged outputs.
- **P5 — Preview equals launch.** For every profile and project path, each
  non-credential preview field equals the production
  `resolveClaudeProfile` output field; credential fields render names,
  presence, and source only. Generator: catalog fixtures × profiles; seam:
  the preview projector composed over the production resolution.
- **P6 — Trust does not descend.** A project-level file setting
  `enabled`, `headers`, `authTokenEnv`, or `balanceKeyEnv` is rejected
  whole with the file named; the rest of the catalog resolves. Generator:
  each field × each project file position; seam: the catalog parsers.

### Completeness claim (D9)

Axes: token variable (present/absent) × model-list outcome (ok /
auth-failure / unavailable) × model-request outcome (ok / auth-failure /
forbidden / model-not-found / network / timeout). Every reachable
combination maps to exactly one of F1–F9; the unreachable ones (F1 with any
request outcome — nothing spawns without the variable; list auth-failure
with request success — the request path shares the list's credentials) are
listed here with their reasons. Model-based tests run the table as the
reference classifier over seeded evidence sequences, including a test-run
timeout at the process-kill boundary and a cached-list TTL expiry mid-test.
The ANTHROPIC_CUSTOM_HEADERS format flagged in the design-challenge note is
now grounded: the CLI documents `Name: Value`, newline-separated for multiple
headers (v2.1.227+; a malformed character fails the request naming the pair) —
D2 cites it; the fixture e2e still asserts the composed value reaches the
relay.
