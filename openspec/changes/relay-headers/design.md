# Design

## Context

This slice implements `provider-relay-setup` §4 (tasks 4.1–4.3) on the
current tree. The umbrella's D2 is the design basis, together with its
layering row L8, table W's W4 row, the trust half of P6 for `headers`, and
D12 obligation 1. They are copied verbatim into the appendix. The `enabled`,
template, and retained-default states that D2 lists are held (task-c6bfbd04);
here "any entry state" means every state the current catalog parses.

Source pin: `f52963d0ab20d5ff9693fcd941e3c3f17970aa26`.

## Current inventory at f52963d0

- `src/server/chat/catalogParse.ts` (369 lines): no `headers` field.
  `CREDENTIAL_NAME_FIELDS = ['authTokenEnv', 'balanceKeyEnv']` (:46);
  `CREDENTIAL_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/` (:48, module-private);
  `validateEnv` (:69) rejects any env name outside `PROFILE_CONTROLLED_ENV`
  (:20-26), so `ANTHROPIC_CUSTOM_HEADERS` in catalog env is refused; the
  credential fields are validated at :287-292; executable vs credential
  exclusion at :362.
- `src/server/chat/catalogMerge.ts`: `providerCredentialed` (:85) counts only
  `authTokenEnv`/`balanceKeyEnv`.
- `src/server/chat/profileCatalog.ts`: `credentialNames` collects
  `authTokenEnv`/`balanceKeyEnv` from every parsed layer (:297, :314-315),
  which feeds the registry's catalog source.
- `src/server/chat/ClaudeProfiles.ts` (310): the token is injected as
  `ANTHROPIC_AUTH_TOKEN` (:176-177) with `BLANK_OTHER_CREDENTIALS =
  {ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN}` (:253); transport pins
  `TRANSPORT_PIN_ENV` (:260); the collision refusals (:210-217). Nothing
  composes or blanks `ANTHROPIC_CUSTOM_HEADERS`, so today an ambient
  `ANTHROPIC_CUSTOM_HEADERS` in the server env rides the filtered env on
  every Claude branch.
- `secretNameRegistry.ts:26` has an explicit, empty `headerVariables` source.
- Prior art, not used by Kawai's launch: `packages/agent-runtime/src/profiles/claude.ts:47,106`
  (`customHeaders` → `ANTHROPIC_CUSTOM_HEADERS` in the package's proxy profile
  composer; it lists the variable among its credential names, :58). Kawai
  composes launches in `ClaudeProfiles.ts` and passes them through
  `provider/claudeRuntimeLaunch.ts`.
- The e2e fixture chat (`AGENTBOARD_CHAT_FIXTURE`) is SDK-independent, so it
  cannot observe a real CLI process environment.

## Source partition (this slice's rows)

| Source item | Disposition |
| --- | --- |
| task 4.1 parse + trust + collisions + headers-only credential-bearing | group 1 |
| task 4.2 composition at launch | group 2 |
| task 4.3 sentinel-only CLI fixture (D12-1) | group 3 |
| requirement "A provider may bind custom headers to credential variables" | here; the "enabled, disabled, retained, or template" list reads "every parsed layer in any entry state", and the held states arrive with the held lineage |
| scenario "Empty variable omits the header" | here, launch half; "the preview marks it missing" → `relay-setup-flow` preview |
| requirement "Bound headers compose into the launch environment" | here, plus the scenario "A header value carrying a line break is refused" (stating the requirement's CR/LF/NUL clause) |
| requirement "A headers-only provider pins its route" | here |
| body clause "every header variable" of "Registered secret names stay withheld" | here, as acceptance A2 (registry source wired); no spec block is modified |
| P6, `headers` half (project files refuse `headers`) | here as property PH6 |

## Decisions

**H1 — Parse at the trusted tier only.** `headers` follows `authTokenEnv`'s
placement rule. A project `providers.json` or any `profiles.json` setting it
is rejected whole, naming the file and the field. Header names must be
RFC 9110 field-name tokens, variables must match `CREDENTIAL_NAME_PATTERN`,
and two names equal case-insensitively refuse the file, naming the header.

**H2 — Register at parse.** `resolveProfileCatalog` adds every header
variable of every parsed layer to `credentialNames`. The registry's catalog
source then covers headers, so the separate `headerVariables` source is
used only if implementation prefers it. Either way, A2 is asserted at a real
launch.

**H3 — Compose in `ClaudeProfiles.ts`.** Bindings resolve through the
credential composition (`provider-credential-store`). Each non-empty
resolved value becomes `Name: Value`, the lines are newline-joined, and the
result is set as `ANTHROPIC_CUSTOM_HEADERS` in the launch env only. It never
enters `settings.env`. Kawai does not adopt the package's proxy composer in
this slice; doing so would change every Claude launch.

**H4 — Headers-only is credential-bearing.** `providerCredentialed` returns
true for a provider with `headers`. The existing trusted invariants then
require a trusted base URL and forbid an executable, and the credentialed
branch pins the base URL and `TRANSPORT_PIN_ENV`.

**OD-H1 (open, decide before group 2):** an ambient `ANTHROPIC_CUSTOM_HEADERS`
on a credentialed or headers-only launch. Options: (a) the composed value
replaces it, and a credentialed launch without headers blanks it, so an
ambient header never reaches a pinned relay (recommended; this extends
`BLANK_OTHER_CREDENTIALS`); (b) leave today's pass-through. Default and
wrapper launches keep today's behavior either way (W1). Option (a) changes
what existing credentialed launches receive, so it is a Lead decision.

## Acceptance oracles

### Parse table HP

| Id | File | `headers` value | Result |
| --- | --- | --- | --- |
| HP1 | user `providers.json` | `{"x-bf-vk": "RELAY_VK"}` | accepted; `RELAY_VK` in `credentialNames` |
| HP2 | project `.kawai/providers.json` | any | file rejected whole naming file and `headers`; rest resolves |
| HP3 | any `profiles.json` | any | file rejected whole naming file and `headers` |
| HP4 | user `providers.json` | `{"X-Bf-Vk": "A", "x-bf-vk": "B"}` | rejected naming the colliding header |
| HP5 | user `providers.json` | variable `relay_vk` (lower case) | rejected naming the field |
| HP6 | user `providers.json` | header name with a space or colon | rejected naming the header |
| HP7 | user, `headers` without `authTokenEnv`, no base URL | — | rejected naming the provider |
| HP8 | user, `headers` + `executable` | — | rejected (credential-bearing takes no executable) |
| HP9 | catalog `env` sets `ANTHROPIC_CUSTOM_HEADERS` | — | rejected as today (message routing is `relay-setup-flow`'s 7.4) |

### Composition table HC (resolved values; observable in the launch structure)

| Id | Bindings | Resolved values | `ANTHROPIC_CUSTOM_HEADERS` in env | `settings.env` | Other |
| --- | --- | --- | --- | --- | --- |
| HC1 | `x-bf-vk → RELAY_VK` | `RELAY_VK=v1` | `x-bf-vk: v1` | no header value | `RELAY_VK` absent under its own name |
| HC2 | two bindings | both set | two lines, binding order | none | both variables absent |
| HC3 | two bindings | one empty | one line | none | launch proceeds |
| HC4 | one binding | empty | variable absent | none | launch proceeds |
| HC5 | one binding | value with CR, LF, or NUL | — | — | launch refused naming the header, value never in the message |
| HC6 | headers-only provider | set | composed | base URL and `TRANSPORT_PIN_ENV` pinned as for a credentialed launch | no `ANTHROPIC_AUTH_TOKEN` composed |
| HC7 | token + headers | both set | composed | none | `ANTHROPIC_AUTH_TOKEN` composed as today |
| HC8 | no headers, credentialed | — | per OD-H1 | none | unchanged otherwise |
| HC9 | binding variable also a launch-env store entry | set | composed through the binding | none | the launch-env entry is inert (W7) |

### Properties

- **PH6 — Trust does not descend for `headers`.** For every project-file
  position, a file setting `headers` is rejected whole, the file is named,
  and the rest of the catalog resolves. Generator: catalog fixtures × project
  file depth; seam: the catalog parsers; fixed seed, 100 cases.
- **PH1 — Header values never leave the composed variable.** Seeded
  bindings and sentinel values: no sentinel appears in `settings.env`, any
  log line, any HTTP response body, or the launch env under any name other
  than `ANTHROPIC_CUSTOM_HEADERS`. Seams: `resolveClaudeProfile`, the
  logger, and the profiles routes. Fixed seed, 200 cases.

### Production-composition oracles

| Id | Path | Observable | Mutant it must kill |
| --- | --- | --- | --- |
| HW1 | user catalog with `headers` + store value → `ChatSessionManager` send → `claudeRuntimeLaunch` options | the driver's launch configuration carries the composed variable and not the source variable ("Header binds a virtual key") | composition attached to `settings.env` instead of `env` |
| HW2 | header variable removed from the catalog → respawn | the variable stays withheld (registry) | header variables not added to `credentialNames` |
| HW3 | HC5 through the manager | the send settles failed, no child, the message names the header | refusal replaced by silent omission |

## Implementation contract

### Acceptance
- A1: Every HP row holds through `resolveProfileCatalog` with the rejection naming the file and field (HP2-HP8), and PH6 passes.
- A2: Every header variable named at any parsed layer is withheld from Claude and Codex launches under its own name, including after its binding is removed (HW2), through the real registry.
- A3: Every HC row holds at the launch structure `resolveClaudeProfile` produces, and HW1/HW3 hold through `ChatSessionManager` and `provider/claudeRuntimeLaunch.ts`.
- A4: PH1 passes; no header value appears in `settings.env`, logs, or response bodies.
- A5: The sentinel-only CLI fixture records what the CLI process env and one Bash tool child hold on the supported CLI baseline (umbrella D12-1); if the CI environment cannot run the real CLI, the result says so and the docs claim mechanism parity only.
- A6: OD-H1 is decided and journaled before group 2 code, and HC8 asserts the chosen behavior.

### Invariants
- I1: `ANTHROPIC_CUSTOM_HEADERS` is never present in the flag settings layer.
- I2: No header value is written to a log line, SQLite row, wire-log frame, or client payload.
- I3: Default and wrapper launches without headers deliver the same environment as before this change (W1).
- I4: `openspec/changes/provider-relay-setup/**` stays byte-identical; no held task changes.

### Scope
- `openspec/changes/relay-headers/**`
- `src/server/chat/catalogParse.ts`
- `src/server/chat/catalogMerge.ts`
- `src/server/chat/profileCatalog.ts`
- `src/server/chat/ClaudeProfiles.ts`
- `src/server/chat/secretNameRegistry.ts`
- `src/server/chat/provider/claudeRuntimeLaunch.ts`
- `src/server/__tests__/*eader*.test.ts`
- `src/server/__tests__/catalog*.test.ts`
- `src/server/__tests__/registeredNames*.test.ts`
- `tests/e2e/relay-headers-sentinel.spec.ts`
- `docs/claude-session-profiles.md`
- `openspec/specs/claude-session-profiles/spec.md`

### Verification
- V1: Tables HP and HC run verbatim as table-driven tests; PH6 and PH1 run as seeded properties through `propertyCases`.
- V2: HW1-HW3 run through the production composition, and each named mutant fails its test.
- V3: Preserved workflows pass unchanged: the existing catalog parse/merge tests, the registry tests, the openrouter credentialed-launch tests, and the named-profile launch tests.
- V4: Citation preflight zero unresolved; the clean committed head passes `bun run check --full-properties` (pinned Bun 1.4.3); `bun scripts/verify-result.ts` exits 0.
- V5: The sentinel fixture runs only with sentinel values on a loopback relay in CI or a disposable environment; no real credential or relay is contacted.

### Excluded
- X1: `enabled: false`, templates, retained defaults, install modes (held lineage).
- X2: Preview, source listing, connection test, rejection-message routing (`relay-setup-flow`).
- X3: The setup editor that writes `headers` (`relay-setup-flow` group 1).
- X4: Adopting the agent-runtime proxy profile composer for Kawai launches.

## Execution checkpoints

1. Decide OD-H1 (Lead), and journal it.
2. Group 1 (parse): HP table plus PH6. Checkpoint: HP2 and HP7 through the
   real `resolveProfileCatalog`.
3. Group 2 (compose): first production path HW1 plus one failure path HW3,
   journaled before the rest of HC.
4. Group 3 (sentinel fixture): A5, with its environment limits recorded.
5. Final: docs, preflight, certificate, one complete result.

## Dependencies and serialization

- **Correctness prerequisite:** `provider-credential-store`, because header
  values resolve through its composition and the "Header binds a virtual
  key" scenario uses a store value.
- **Shared files:** `ClaudeProfiles.ts` and `catalogParse.ts` are shared with
  `mimo-million-token-context` (catalog env and launch), rename group 1 and
  the held install-modes lineage (`catalogParse.ts`, `catalogMerge.ts`). This
  is serialization only.
- **Downstream:** `relay-setup-flow` (editor, preview header names,
  `header-config-error` class) and `fixture-relay`.
- **Archive:** adds to `claude-session-profiles`. Serialize with the other
  changes that modify that main spec (mimo, credential-store, rename); its
  requirements are ADDED, so archive order affects only the file.

## Risks

- Whether a Bash tool child inherits the composed variables depends on the
  CLI. A5 records it; the design does not claim it.
- OD-H1 option (a) changes existing credentialed launches. A wrong choice
  is caught by HC8 and the openrouter regression tests.

## Appendix — inherited text (verbatim from `provider-relay-setup/design.md` at f52963d0)

Copied unchanged for implementer context; the sections above decide scope.

### D2 (lines 306-398)

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


### Layering row L8 (line 1023)

| # | Id | User-level entry | Project entry | Resolved |
| --- | --- | --- | --- | --- |
| L8 | `claude` | sets only `headers` | none | `claude` gains headers; base URL, models, env inherited (fixture synthetic: `claude` plus headers makes it headers-only credentialed — requires a trusted base URL in the entry) |

### Table W row W4 (line 1053)

| W# | Name registered? | Store entry kind | Passes the pre-branch filter? | Where it reaches a launch | Listing shows |
| --- | --- | --- | --- | --- | --- |
| W4 | yes — header variable, any state | — | no | only inside composed `ANTHROPIC_CUSTOM_HEADERS` | registered name |

### P6 (lines 1233-1238)

- **P6 — Trust does not descend.** A project-level file setting
  `enabled`, `headers`, `authTokenEnv`, or `balanceKeyEnv` is rejected
  whole with the file named; the rest of the catalog resolves; a
  headers-only provider counts as credential-bearing for these refusals
  and for the trusted invariants. Generator: each field × each project
  file position; seam: the catalog parsers.

### D12 obligation 1 (lines 924-932)

1. **Sentinel-only CLI fixture** (D2's exposure boundary, P1): a fixture
   relay and sentinel secret values establish what the CLI process env
   holds, what a Bash tool child sees on the supported CLI baseline (the
   withheld names absent; the only credential values present in this
   baseline are the two composed variables — a configured launch-env entry
   delivers as itself, W6/W9), and
   that the flag settings layer carries no token or header value. Recorded
   as an e2e assertion; until it runs, the design claims parity of
   mechanism, not measured exposure.
