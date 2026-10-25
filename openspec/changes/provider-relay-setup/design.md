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
rename + fsync) **before** any SQLite write; (2) then, in one SQLite
transaction, the map row is deleted and the migration stamp is committed.
The stamp's presence never re-runs the migration.

**Crash, collision, and restart table** (each row is the state a restart
finds, and what it does):

| Crash point | Store file | `app_settings` | Restart behavior |
| --- | --- | --- | --- |
| before the store write | old | map present, no stamp | migration re-runs from the start; nothing was moved |
| after the store write, before the SQLite transaction | moved entries present | map present, no stamp | re-run: a map entry whose store name already holds the **same** value is absorbed silently (idempotent); a **different** value is a collision — the store entry wins, and the skip is recorded in the source listing as "legacy Settings `<NAME>` not migrated: the store already holds `<NAME>`"; then the map row is deleted and the stamp commits |
| after the SQLite transaction | moved entries present | map deleted, stamp set | never re-runs (stamp) |

A restored pre-upgrade backup (map present, no stamp) re-runs the migration
the same way; entries the later store already holds absorb or collide per
the middle row. Concurrent store saves serialize in-process.

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
settings layer never carries a token or header value**; (d) **an explicitly
filtered environment on every branch** — no launch branch inherits the
server process environment raw: every Claude and Codex launch receives an
explicitly filtered environment (D5's composition table). The withheld set
on every branch is the registered-name set of table W: every catalog
binding name (`authTokenEnv`, `balanceKeyEnv`, every header variable) at
any layer in any state — enabled, disabled, retained default, or template —
every secret-source store key, and every retained name. The controlled/
transport-pin variables are **not** in that set: their deletion and pinning
are branch-specific operations the composition table applies (named-profile
deletion, credentialed/header transport pins, Codex's trusted-tier facts),
so a Default or wrapper launch keeps an ambient `ANTHROPIC_BASE_URL` or
`HTTPS_PROXY` exactly as at the base. An ambient credential whose name
nothing registers (a bare `ANTHROPIC_AUTH_TOKEN` in the server env with no
catalog entry naming it) passes the filter exactly as it does today —
stated, not hidden (D5, W1).
What a Bash child
actually sees on the supported CLI is established by the sentinel-only
fixture test (D12); until that evidence exists this design claims **parity
of mechanism** with the token path, not parity of measured exposure.

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

**Alternatives:** values inline in catalog files — refused forever
(credential values never enter files); per-model headers — a header binds to
the relay account, not the model; a free-form env entry — that is the
rejected `ANTHROPIC_CUSTOM_HEADERS` path that started this.

## D3 — Catalog assembly: install modes; merge by construction; `default` untouchable

**Install modes (L-A).** How the shipped tier composes with operator files
follows a durable, non-secret **install-state record** (an `app_settings`
key, tables S/ST/SR): `{ mode: 'merge' | 'replace', retained: 'none' |
'present' | 'retired' }`, written once from stable install facts, idempotent
across restarts and crashes, and changed only by the operator. The record —
not the file layout — is what restarts read, so fresh and retained installs
stay distinct after their first start:

- **Fresh install** (S1, `{merge, none}`): the shipped catalog is Anthropic +
  OpenAI only (D4), and user/project files **merge** over it field by field.
  No mode choice exists. The bootstrap records the durable fresh origin
  fact (tables S/ST/SR) and the state commits at the same startup; a crash
  in between recovers as fresh (SR5) — no fresh install ever acquires the
  retained layer.
- **Existing install, no user-level catalog file at upgrade** (S2,
  `{merge, present}`): the trimmed shipped set applies plus the
  **retained-defaults layer** (D4 — the removed entries stay at the shipped
  tier with their exact facts). User/project files merge over
  shipped+retained, so every pre-upgrade reference keeps resolving exactly
  as before. Restarts keep the layer (SR2); retiring it persists `retired`
  (ST2/SR3).
- **Existing install with a user-level catalog file at upgrade** (S3,
  `{replace, none}`): **whole-file replace semantics are kept** — the user
  files stand alone, no shipped or retained entries sit beneath them,
  exactly today's behavior — until the operator switches to merge from the
  source listing **after previewing the effective-catalog difference**
  (D7; ST1 persists the switch and never grants retained entries). Absence
  is preserved exactly (P3): an omitted optional model field or env key
  stays absent under replace.

**Merge semantics** (fresh and opted-in installs, and project files in
every mode). Same-id entries merge per field as they already merge across
project levels (nearer wins per env key, empty neutralizes, scalars
nearest-set-wins). The existing trust refusals apply **before** any merge,
with `openrouter-provider`'s precise boundary: a project file may overlay
**labels and model mappings** on a credential-bearing id (now including
headers-only providers), but a project file that sets or overrides its base
URL (route), re-homes its model under another provider id, or names a
credential field (`authTokenEnv`, `balanceKeyEnv`, `headers`) — or sets
`enabled`/`executable` — is rejected whole exactly as today
(`enforceTrustedCredentialInvariants` and the trusted-tier checks;
`catalogMerge.ts:175–184, 379–426, 430–437`). Labels and model mappings
staying overlayable is the preserved openrouter-provider behavior, not a
new relaxation.

**Disable is a trusted tombstone — named ids only.** `enabled: false` on a
**user-level** entry removes that named id from the resolved catalog — the
provider entry, every model key that resolves to that provider, and any
Codex profile of that id — and leaves a tombstone that **nearer tiers
cannot resurrect**: a project file re-defining the id (with or without
`enabled`) resolves nothing for that id while the tombstone stands, because
the project tier sits below the user tier's explicit removal. A user-level
entry for the same id **without** `enabled: false` replaces the tombstone.
Tombstone suppression covers a named id's synthesis paths; **`default` is
never tombstonable** — the resolved catalog always includes `default` (main
spec), so `enabled: false` on the `default` profile is refused at parse
naming the file, and so is `enabled: false` on a provider that carries it
(the shipped `claude` provider holds the `default` profile — removing the
provider would remove `default`; the layering table's tombstone fixtures
are non-default holders, L2/L5), and the implicit-default synthesis
(`catalogMerge.ts` `finish()`) is never suppressed. `enabled` below the
user level is rejected whole, naming the file. A model id re-homed under a
*different* provider id is a different id and resolves normally unless that
id is itself tombstoned.

**Fixture honesty for the layering table.** After D4 the only shipped
provider entry in `providers.default.json` is `claude`, beside the tracked
Codex entries in `profiles.default.json` (`openai`, `codex-sol`,
`codex-luna`; table G); layering rows use ids that remain shipped (`claude`,
`openai`), retained defaults (`mimo`, `zai`, … on upgraded installs), or
explicitly labeled synthetic fixtures (a user-defined `relay` id). A `zai`
fixture on a fresh install is labeled synthetic — `zai` ships only in
templates there.

**Regression oracle (P3, two halves).** (a) *Replace mode*: an upgrade
changes nothing — user-file catalogs resolve identically before and after,
including complete copies, partial copies, omitted optional model fields,
and absent env keys (absence preserved exactly). (b) *Merge mode*: complete
copies resolve identically to replace; an omitted optional field reappears
from the lower layer — that inheritance is the documented difference the
opt-in preview shows, asserted as the previewed difference, never claimed
absent. Runtime-origin placements are the one exclusion: under replace a
user-level Codex entry could convert a model key because the shipped files
had vanished; under merge the shipped Claude origin sits beneath and
`addCodexProfile` refuses the conversion (`catalogMerge.ts:451–458`) — the
refusal is the documented runtime-origin behavior, tested as its own case.

## D4 — Shipped catalog trimmed to Anthropic and OpenAI (Codex); templates

**Choice.** `config/providers.default.json` keeps only the `claude` provider
(Default, Opus, Sonnet, Haiku — host claude.ai login / global credentials).
`config/profiles.default.json` keeps exactly the Codex entries a tracked
group file names (table G, L-G): `openai` (`runtime: "codex"`, label
"OpenAI (Codex)", no pinned model — the Codex app-server default, default
Codex home) plus `codex-sol` and `codex-luna`, the shipped Codex profiles
task-b38ad618 adds and tracked dev groups name as workers; composition with
that task is G8 (whichever change lands second rebases onto the other). A
fresh instance keeps working non-Claude providers without credentials in
kawai's control. The removed entries — `zai` (glm, glm-flash), `minimax`,
`mimo`, `kimi`, `openrouter`
(openrouter-opus/sonnet/haiku/deepseek-flash/minimax-flash) — ship verbatim
in a new `config/provider-templates.json`, each with the credential variables
to import (`ZAI_API_KEY`, `MINIMAX_API_KEY`, `MIMO_API_KEY`, `KIMI_API_KEY`,
`OPENROUTER_API_KEY` + `OPENROUTER_MANAGEMENT_KEY`). Public provider
endpoints stay as they are today in the shipped files; nothing private enters
the repository. The setup surface (D7) offers each template for adoption:
writing the entry into the user-level catalog unchanged (ids preserved) and
importing the credential values into the store (D1).

**Compatibility by construction (L-A) — no adoption writes, no reference
discovery.** Kawai does not scan stored sessions, group files, routing
rules, or queued mail to reconstruct what the trim removed (routing-rule
picks are computed by `route(ctx)`, not enumerable, and adoption would
change a file's origin under it); it **keeps the removed entries where they
already were**:

- **Existing installs without a user-level catalog file** (most installs —
  including this repository's): the removed entries **stay at the shipped
  tier, verbatim, as the retained-defaults layer**. Every consumer keeps
  resolving exactly as before the trim: stored sessions on
  `mimo`/`zai`/`openrouter-*` resume; group workers (`glm-flash`, …) and
  routing rules' dynamic picks resolve; project overlays of retained ids
  apply as they always did. The source listing labels the layer **"retained
  default"** and offers **Retire** beside it, enabled after the operator
  previews the effective-catalog difference (which ids and fields go away,
  which stored sessions and groups would degrade). Retiring removes the
  entries and persists `retained: 'retired'` in the install-state record
  (ST2/SR3) — it stays retired across restarts and crashes; from then on
  the unknown-profile degrade and the no-worker wait
  (below) are the honest signals, and the templates restore ids on demand.
  Fresh installs have no retained layer — it exists only where the previous
  shipped entries were actually served.
- **Existing installs with user-level files**: whole-file replace semantics
  are unchanged (D3) — nothing an upgrade does can inject entries under a
  deliberately curated catalog.
- **Fresh installs**: Anthropic + OpenAI only; templates one click away.

The install-state record (D3, tables S/ST/SR) persists the mode and the
retained layer's presence or retirement — nothing secret, nothing else; no
discovery pass runs at startup.

**No default fallback (L-A), scoped to declared lists.** A group that
**declares** a worker list (`workers`/`profiles`/`profile`, bare or
qualified) whose ids all fail to resolve never falls back to the default
profile: `workerEligibility.ts:198`'s
`profiles.length > 0 ? profiles : [DEFAULT_PROFILE_ID]` substitution is
removed for declared lists, and the router's worker-choice resolution
against such a list narrows to nothing. The group's mail waits with a named
reason ("no defined worker for group …; profile(s) … are not in the
catalog") and the group shows a warning — it does not silently run on
`default`. A group with **no** worker field keeps today's behavior (the
default profile — the main staffing spec's unspecified case), and
**`default` itself cannot be tombstoned** (D3), so the fallback's target
always exists for the no-field case. The declared-list wait is reachable
only after an operator retired retained entries or disabled ids still
referenced — then the wait is the honest signal.

**Degrade (post-retire or template-less):** a stored session on an unknown
id stays visible and blocks sending with the restore message naming the
matching template when one exists; unknown group worker keys are warned and
dropped (`groupCatalog.ts:125–159`). Both paths keep today's shape for ids
with no template (a hand-typed id never existed shipped) and for ids whose
template was not adopted after a retire.

**Upgrade-compatibility tests (required by the direction).** (a) A fresh
instance resolves exactly the shipped catalog — the `claude` provider and
the tracked Codex entries (`openai`, `codex-sol`, `codex-luna`; G1/G2).
(b) An upgraded install
without user files keeps `mimo`, `glm-flash`, and `openrouter-*` resolving
through the retained layer — a stored session resumes, the group's workers
spawn, the listing marks "retained default". (c) An upgraded install with a
complete-copy user catalog resolves exactly today's catalog (replace mode;
P3's replace half). (d) Retiring the retained layer after the preview
removes the entries; a still-referenced id then degrades (stored session)
or waits (declared worker list) with the named reasons, and adopting its
template restores it. (e) Partial project overlays of a retained id keep
applying before and after retire (before: retained facts beneath; after:
the overlay alone, or nothing), and an omitted optional field under a
post-retire merge behaves per P3's merge half. (f) The tracked-worker guard
(G7), revised by name in the trim PR (`shippedCatalog.test.ts` › "the
tracked group files name profile ids the shipped catalog resolves"):
resolves each named id against shipped ∪ the retained-defaults inventory so
a typo still fails — a fresh-context scenario (Claude and Codex ids resolve,
others warn as unknown ids) and a retained-context scenario (every tracked
id resolves).

**Alternatives:** keep the entries but hide them — the picker stays noisy and
the trim's purpose (a fresh instance shows only what works out of the box)
fails; drop removed ids entirely — breaks this team's own workers and every
stored session; auto-adopt referenced ids — unbounded discovery (route(ctx)
picks are computed, not stored) and adoption changes origin-holder facts
under the reference (L-A rejects it); temporary fallback routing to
`default` — silently runs team work on the host login, the failure mode L-A
rejects.

## D5 — One precedence table

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
presence and origin. Entries served by the retained-defaults layer (D4)
are marked **"retained default"**, so an operator can see why an id they
never configured is offered. The New Session dialog and Settings render the listing prominently
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

## D11 — Composition with the active changes

**`openrouter-provider` (19/20).** This change builds on its landed deltas
(`authTokenEnv`, `balanceKeyEnv`, withholding, base-URL pinning, the
`credit` window) and **REMOVEs** its ADDED requirement "The shipped catalog
includes OpenRouter" (the shipped `openrouter` provider moves into the
templates verbatim, ids preserved; the REMOVED block's migration text
describes the retained-defaults layer and templates, per D4). Its precise
project-file boundary — labels and model mappings overlayable; route,
re-home, credential fields, `executable` rejected — is restated, not
broadened (D3).

**`rename-agentboard-to-kawai` (active, 0/35).** It renames the chat-env
seed `AGENTBOARD_CHAT_ENV` → `KAWAI_CHAT_ENV` in main specs and code and
MODIFIES the same main requirement this change modifies ("Named profiles
configure independent provider sessions"). **Archive order:
`rename-agentboard-to-kawai`, then `openrouter-provider`, then this
change.** This change's MODIFIED "Named profiles…" block is authored
against rename's final text — all eight scenarios, `KAWAI_CHAT_ENV`
spelling — changing only the "Effective global provider overrides"
scenario (the persisted Settings override becomes the store's launch-env
entries, per L-B), and is re-checked at rebase before this change archives.
This design's tables write `KAWAI_CHAT_ENV` for the seed with the old name
noted once. If rename stalls before archiving, this change's spec work
pauses on that one delta rather than emitting a MODIFIED against text that
does not exist yet.

This change does not modify openrouter-provider's credit-limit, usage-pull,
or cost-display deltas, or rename's other deltas; `limitSignals`' table is
untouched (D9).

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
   crash-safe migration per D1's table — the durable store-file write lands
   **before** the one SQLite transaction that deletes the map row and
   commits the stamp (the file write is never transactional with SQLite);
   a restored pre-upgrade backup re-runs it.
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

## D13 — The setup write path (the owning surface for operator catalog edits)

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

## Acceptance oracles

Decision tables: D5's precedence table, D9's ordered classifier, the
layering table, the withholding-and-delivery table (B1), the install-state
table (B2), and the tracked-workers table (N1) below. Properties P1–P7 pin
the invariants. Every row gets an oracle id (`L#`, `W#`, `S#`/`ST#`/`SR#`,
`G#`, `D#` for D9 rows, `P#`) that tasks.md cites; each executable form
runs as a table-driven test next to the code it covers.

### Layering table (D3/D4)

| # | Id | User-level entry | Project entry | Resolved |
| --- | --- | --- | --- | --- |
| L1 | `claude` (shipped, non-credentialed) | none | none | present, shipped settings |
| L2 | `zai` (retained default on an upgraded install — a non-default holder; D3 refuses disabling any provider carrying `default`) | `enabled: false` | * | absent, with every model key resolving to it (`glm`, `glm-flash`) — trusted tombstone |
| L3 | `claude` | overrides base URL | none | present, user base URL, shipped siblings intact |
| L4 | `claude` | none | overrides base URL | present, project base URL for that project path — **non-credentialed ids only**; a credential-bearing (incl. headers-only) id rejects the project file whole instead, per D3 |
| L5 | `zai` (upgraded install, as L2) | `enabled: false` | re-defines `zai` (no `enabled` key) | still absent for that project path — the tombstone suppresses nearer tiers; a project file can neither set `enabled` (rejected whole) nor resurrect the id |
| L6 | none (new id `relay`) | defines `relay` | none | present as user provider |
| L7 | `claude` | defines `claude` complete (non-runtime fields) | none | replace-mode install: identical resolved settings to today (P3's replace half); after an opt-in to merge: identical for complete copies; omitted optional fields inherit per the merge rules the opt-in preview showed (P3's merge half); runtime-origin placements excluded and covered by their own runtime-origin test (D3) |
| L8 | `claude` | sets only `headers` | none | `claude` gains headers; base URL, models, env inherited (fixture synthetic: `claude` plus headers makes it headers-only credentialed — requires a trusted base URL in the entry) |
| L9 | `mimo` (removed shipped id, upgraded install, no user files) | none — retained default | none | the retained-defaults layer serves the id with its exact shipped facts (D4): stored sessions resume, groups spawn, listing marks "retained default"; Retire (after the preview) removes it, and then the degrade/wait paths apply; adopting the template restores it. No startup pass adopts, discovers references, or writes files (L-A) |
| L10 | `default` | `enabled: false` | * | refused at parse, naming the file — `default` cannot be disabled; the resolved catalog always includes `default` (main spec) |

L5's mechanism is the tombstone's suppression, not the `enabled` field
refusal alone: a project file re-defining the id without naming `enabled`
resolves nothing while the tombstone stands (D3).

### Withholding-and-delivery table (B1, L-H) — table W

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

### Install-state table (B2) — tables S/ST/SR

One durable, non-secret record (an `app_settings` key) holds the install
state: `{ mode: 'merge' | 'replace', retained: 'none' | 'present' | 'retired' }`.
It is the single source the catalog assembly reads, written once from
stable install facts, changed only by operator transitions, and never
re-derived from file absence. **Creation is not atomic with the database**:
the database file, the schema, and the state record commit at separate
instants of the same startup, so recovery reads a **durable origin fact**
the bootstrap itself records — the baseline (version 1) writes whether it
created the schema from an empty database file (`origin: 'fresh'`), stamped
with the version row and surviving every crash. Install-state init
consults that fact, never "does a file exist".

Init rows (inputs → state; each install observation matches exactly one):

| S# | Install observed | State persisted | Assembly selected |
| --- | --- | --- | --- |
| S1 | origin `fresh` (the baseline created this database) | `{merge, none}` | shipped Anthropic+OpenAI (D4); user/project files merge |
| S2 | pre-existing database (no fresh origin), no user-level catalog file | `{merge, present}` | shipped + retained-defaults layer; user/project merge above |
| S3 | pre-existing database, a user-level catalog file exists | `{replace, none}` | the user files stand alone; nothing beneath them |

Operator transitions (each persists durably before taking effect):

| ST# | Transition | What persists |
| --- | --- | --- |
| ST1 | opt into merge, after previewing the effective-catalog difference | `mode: 'replace' → 'merge'`; `retained` unchanged — a legacy-replace install never acquires the retained layer |
| ST2 | retire the retained layer, after the preview | `retained: 'present' → 'retired'` |

Recovery rows — partial states **fail closed**: a fresh-origin database
never serves the retained layer, whatever a crash left behind, and a
malformed state record is reported and re-derived once:

| SR# | State found at restart | Behavior |
| --- | --- | --- |
| SR1 | `{merge, none}`, origin fresh | no retained entries acquired, ever — fresh stays fresh |
| SR2 | `{merge, present}` (upgraded) | the retained layer still serves its entries with their exact shipped facts — nothing is lost |
| SR3 | `{merge, retired}` | stays retired across restart and crash — retirement is recorded, not inferred |
| SR4 | `{replace, none}` | replace holds until ST1; once recorded, the opt-in persists |
| SR5 | database exists, no state record, origin fresh | init runs S1 — a crash after baseline but before the state commit recovers as fresh; the trimmed shipped set is the closed failure, never the retained layer |
| SR6 | database exists, no state record, pre-existing origin | init runs S2/S3 on the install facts — idempotent, the facts are stable |
| SR7 | no database file | baseline (with the origin fact) and the state record are written at startup; a crash at any point leaves SR7 or SR5, both closing to fresh |
| SR8 | state record unreadable or self-contradictory (e.g. fresh origin with `retained: present`) | reported in the source listing, then re-derived once from the durable origin and install facts; origin fresh forces S1 |

Unreachable: `{merge, present}` on a fresh-origin install (SR5 forces S1;
the layer exists only where the removed entries were actually served); two
records or two stamps (one record, one write); a retired layer
re-acquired (SR3); an upgraded install losing the layer (SR2); a
legacy-replace install acquiring retained entries at ST1 (ST1 leaves
`retained` unchanged).

### Tracked-workers table (N1, L-G) — table G

Shipping policy: the shipped catalog is the `claude` provider plus exactly
the Codex entries a tracked group file names — at the trim, `openai` and
`codex-sol`/`codex-luna` (task-b38ad618's shipped Codex profiles). Every
other tracked worker id (`glm`, `glm-flash`, `mimo`, `minimax`, `kimi`,
`openrouter-*`) leaves the shipped tier: it lives in the retained-defaults
layer where that layer exists, and resolves as an unknown id nowhere else,
until the operator defines it (template adoption or a user entry).

| G# | Install context | Tracked id | Observable outcome |
| --- | --- | --- | --- |
| G1 | fresh | `claude` ids (default, opus, sonnet, haiku) | shipped; resolves |
| G2 | fresh | `openai`, `codex-sol`, `codex-luna` | shipped (L-G); resolves |
| G3 | fresh | `glm`, `glm-flash`, `mimo`, `minimax`, `kimi`, `openrouter-*` | unknown id: today's group warning; a declared list of only such ids waits with the named reason (no default fallback); the matching template is offered |
| G4 | upgraded, no user files (S2) | the removed ids | retained default, exact shipped facts; resolves; the listing marks "retained default" |
| G5 | upgraded, user files (S3) | whatever the user files define | unchanged from today (replace mode) |
| G6 | upgraded, retained retired (SR3) | a still-referenced removed id | degrade (stored session) / wait (declared list) with the named reasons; template adoption restores |
| G7 | the trim PR's guard test, revised by name: `shippedCatalog.test.ts` › "the tracked group files name profile ids the shipped catalog resolves" | every id named in a tracked group file | resolved against shipped ∪ the retained-defaults inventory, so a typo still fails; fresh-context scenario: the Claude and OpenAI ids resolve and the others warn; retained-context scenario: every tracked id resolves |
| G8 | composition with task-b38ad618 | `codex-sol`, `codex-luna` | whichever change lands second rebases onto the other; the trim keeps both Codex ids shipped |

Unreachable: a tracked id resolving from neither shipped, retained, nor
operator definition — G3/G6 are the honest empty outcomes; a fresh install
serving a retained entry — S1/SR1.

### Properties

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
  shape patterns. Generator: seeded run over random secret shapes; seams:
  the store module, the preview/listing projector, the classifier's
  redactor, the launch composer. Fixed seed, 200 cases, no new dependency.
- **P2 — Write-only store UI.** After any import/replace/blank/clear
  sequence, every read surface returns presence, source, and name only —
  never the value or a prefix, whatever the variable is named (the old
  name-regex hole is closed). Generator: random operation sequences; seam:
  the Settings/projector read paths.
- **P3 — Mode regression (non-runtime).** (a) *Replace mode*: an upgrade
  changes nothing — a generated user catalog (complete copies, partial
  copies, omitted optional model fields, absent env keys) resolves
  identically before and after; absence is preserved exactly. (b) *Merge
  mode* (fresh or opted-in): complete copies resolve identically to
  replace; an omitted optional field reappears from the lower layer, and
  that inheritance is asserted as exactly the difference the opt-in
  preview shows — never claimed absent. The identity claim is on the
  **resolved values and presence**: placement-derived differences merge
  legitimately introduces are not folded into it but carried by their own
  rows — the tier a field reports as origin when the user file omits it
  (the previewed difference), runtime-origin placements (below), and trust
  refusals that attach to a placement rather than a value (P6). Excluded
  and separately tested: runtime-origin placements — a nearer Codex entry
  over a farther-tier Claude origin is refused under merge per the
  runtime-origin rules (`addCodexProfile`), where replace silently allowed
  the conversion; the refusal is the documented behavior, asserted as its
  own case, and P3's generator excludes it. Generator: shipped/retained
  catalog × user catalogs with field mutations, including
  removed-field/negative-space cases; seam: `resolveProfileCatalog` with
  injected homes. Fixed seed, 100 cases.
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
- **P6 — Trust does not descend.** A project-level file setting
  `enabled`, `headers`, `authTokenEnv`, or `balanceKeyEnv` is rejected
  whole with the file named; the rest of the catalog resolves; a
  headers-only provider counts as credential-bearing for these refusals
  and for the trusted invariants. Generator: each field × each project
  file position; seam: the catalog parsers.
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

### Completeness claim (D9)

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
