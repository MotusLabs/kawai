# Claude chat profiles

In New Session, choose **Claude chat**, then select **Profile**. Default is
selected initially. The offered catalog follows the entered project path (see
below). The chat header shows the selected profile. Catalog load failures
block creation and offer **Retry profiles**; terminal command presets are
independent.

The shipped default catalog, grouped by provider:

| ID | Label | Provider | Routing and models |
| --- | --- | --- | --- |
| default | Default | Claude | Existing server environment and global provider Settings |
| opus | Claude Opus | Claude | prescribed model `claude-opus-5-5` |
| sonnet | Claude Sonnet | Claude | prescribed model `claude-sonnet-5-5` |
| haiku | Claude Haiku | Claude | prescribed model `claude-haiku-5-5` |
| glm | GLM | Z.AI | starts on Opus; Sonnet and Haiku map to `glm-5.3-flash[1m]`, Opus and Fable to `glm-5.3[1m]` — provider env below |
| glm-flash | GLM Flash | Z.AI | starts on Sonnet; Opus and Fable map to `glm-5.3[1m]`, Haiku to `glm-5.3-flash[1m]` — provider env below |
| minimax | MiniMax | MiniMax | `https://api.minimax.io/anthropic`; starts on `MiniMax-M3`; every Claude tier maps to `MiniMax-M3` ([reference](https://platform.minimax.io/docs/token-plan/claude-code)) |
| mimo | MiMo | MiMo | `https://api.xiaomimimo.com/anthropic`; starts on `mimo-v2.6-pro`; Sonnet maps to `mimo-v2.6-flash`, Opus/Haiku/Fable to `mimo-v2.6-pro` ([reference](https://mimo.mi.com/docs/en-US/tokenplan/integration/claudecode)) |
| kimi | Kimi | Kimi | `https://api.moonshot.ai/anthropic`; starts on `kimi-k3[1m]`; every Claude tier maps to `kimi-k3[1m]`; auto-compact window `1000000` ([reference](https://platform.kimi.ai/docs/guide/claude-code-kimi#configuration-reference)) |
| openrouter-opus | OpenRouter Opus | OpenRouter | starts on Opus; Opus and Fable map to `~anthropic/claude-opus-latest[1m]` — provider env below |
| openrouter-sonnet | OpenRouter Sonnet | OpenRouter | starts on Sonnet; Sonnet maps to `~anthropic/claude-sonnet-latest[1m]` — provider env below |
| openrouter-haiku | OpenRouter Haiku | OpenRouter | starts on Haiku; Haiku maps to `~anthropic/claude-haiku-latest` — provider env below |

Provider Z.AI carries the pair's shared routing at the provider level:
base URL `https://api.z.ai/api/anthropic`, the four tier maps above,
auto-compact window `1000000`, and reset zone `Asia/Shanghai` — every model
of the provider launches with it, and the provider's cooldown and usage are
shared.

Provider OpenRouter routes through `https://openrouter.ai/api` and maps every
tier: Opus and Fable to `~anthropic/claude-opus-latest[1m]` (OpenRouter
documents no Fable slug), Sonnet to `~anthropic/claude-sonnet-latest[1m]`,
Haiku to `~anthropic/claude-haiku-latest` ([reference](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk)).
`[1m]` only tells Claude Code the context window; OpenRouter strips it before
routing. Its sessions authenticate with the server's `OPENROUTER_API_KEY` —
see [Provider credentials](#provider-credentials).

## Catalog files

Models come from two kinds of catalog files inside `.kawai` directories,
layered like Claude Code settings. For a chat session, the server reads each
level's `providers.json` and then `profiles.json`, from the session's project
path up to the filesystem root, above the user level (`~/.kawai/providers.json`
and `~/.kawai/profiles.json`) that replaces both shipped defaults
(`config/providers.default.json`, `config/profiles.default.json`) when either
of its two files is present — in container deployments, mount the user-level
files (ConfigMap) or bake image defaults. Release builds embed both shipped
files at build time: a compiled binary ships no `config/` directory, so when
a default file is missing the embedded copy supplies it (validated like a
file read, errors naming `config/profiles.default.json (embedded)` or
`config/providers.default.json (embedded)`); when the file exists it is used
as-is.

A `providers.json` holds providers, and a provider owns its models:

```json
{
  "zai": {
    "label": "Z.AI",
    "limitResetTimeZone": "Asia/Shanghai",
    "env": { "ANTHROPIC_BASE_URL": "https://zai.example.internal/api/anthropic" },
    "models": {
      "glm": { "label": "GLM", "model": "opus", "env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000" } },
      "glm-flash": { "label": "GLM Flash", "model": "sonnet" }
    }
  }
}
```

A model launches with its provider's environment merged with its own, its own
values winning per key. A model entry may not set `ANTHROPIC_BASE_URL` — the
base URL belongs to the provider, so every model of a provider reaches the
same endpoint; a file whose model sets it fails validation with an error
naming the file, provider, and model, and the rest of the catalog stays
usable. Credential values are refused at both levels; a trusted provider may
only *name* its credential variables (see [Provider credentials](#provider-credentials)). `executable` stays
provider-level and operator-trusted (see below).

Same-id providers merge across levels with the nearer file winning per key,
and an empty value neutralizes an inherited one; a provider's `models` merge
by key within it. Model keys are unique across the whole resolved catalog —
they are the profile ids sessions, groups, plans, and routing store. A key
defined under two providers of different operator levels (the user level and
the project levels) is an error naming both providers and files; the nearer
definition is ignored. A nearer definition of a key the SHIPPED default holds
re-homes instead: the key leaves its shipped provider and resolves as the
nearer entry — a legacy entry as its own one-model provider — starting from
the shipped model's flattened settings, so an existing project override (for
example a private gateway in a project `profiles.json`) keeps exactly its
launch settings and only that key leaves the provider.

A `profiles.json` entry reads as a provider with one model of the same id:
its label names both, its startup model applies to the model, and its
environment, reset zone, and executable apply to the provider. An entry whose
id is already a model of a different operator provider is ignored with an
error naming both files; an entry whose id is an existing provider id merges
into that provider. A catalog without `providers.json` therefore resolves
exactly as before, one provider per profile. The `default` model is definable
in files — under any provider — and always exists (implicit, provider
`default`, when no file defines it).

The shipped catalog lists public provider endpoints only. Private gateways —
an internal proxy that injects API keys, or a LAN relay — belong in a catalog
kawai does not ship: the user-level `~/.kawai/profiles.json`, or an untracked
project `.kawai/profiles.json` (keep it out of version control). For example:

```json
{ "internal-glm": { "label": "GLM (internal)",
    "env": { "ANTHROPIC_BASE_URL": "https://glm.example.internal/api/anthropic" } } }
```

Entries with the same id merge per environment key: the nearest file wins,
and an empty value neutralizes an inherited value. Scalar fields (`label`,
`model`, `limitResetTimeZone`) follow nearest-set-wins; `label` falls back to the profile id. The
`default` profile is definable in files and always exists (implicit and empty
when no file defines it — global provider configuration alone). Home-relative
project paths (`~/work/app`, as typed in New Session) expand to the server
home before discovery, so the picker and creation read the same files.

```json
{
  "glm-flash": {
    "label": "GLM Flash",
    "model": "glm-5.3-flash[1m]",
    "env": { "ANTHROPIC_BASE_URL": "https://glm.example.internal/api/anthropic" }
  }
}
```

Catalog `env` keys are restricted to the profile-controlled variables
(PROFILE_CONTROLLED_ENV): routing, models, attribution, compaction.
Credential values are never allowed in catalog files; they enter sessions
only through the server environment or global provider Settings, so catalog
files stay safe to commit and mount. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is
profile-controlled too: a provider may cap the output reservation Claude Code
asks for (pay-per-token gateways such as OpenRouter refuse a request whose
reservation exceeds the remaining credit). A file that fails validation is skipped, and
the rest of the catalog still resolves — the failure is never silent: the
picker shows it as a warning next to the profile list, and every launch
resolution logs it (`chat_profile_catalog_errors` in agentboard.log).

## Provider credentials

A provider in a **trusted** `providers.json` — the shipped default or the
user-level `~/.kawai/providers.json` — may name the server environment
variables that hold its keys. Names only, never values; each must match
`^[A-Z_][A-Z0-9_]*$`:

- `authTokenEnv` — the inference key. A session of the provider's models
  launches with `ANTHROPIC_AUTH_TOKEN` set from this variable (Claude Code
  then sends it as `Authorization: Bearer`), and with `ANTHROPIC_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN` blanked both in its environment and in the SDK
  flag settings layer, so neither the host's claude.ai login nor a key in
  project settings can take over. The token itself never enters the flag
  settings (they reach the process's argv).
- `balanceKeyEnv` — an account-level key (for OpenRouter, a management key)
  that only the server reads, for the provider's account credits.

Trust and withholding:

- A project `.kawai/providers.json` naming either field, and any
  `profiles.json` naming one, is rejected whole, naming the file and field:
  project files are agent-writable.
- A project file may not set `ANTHROPIC_BASE_URL` on a credentialed provider,
  nor re-home one of its models to another provider — either would send the
  key elsewhere. The whole file is rejected; model mappings and labels can
  still be overlaid from a file that does not redirect.
- Every variable the resolved catalog names is removed from every agent
  launch — under any profile, Default and executable-backed profiles
  included — so no agent can read another provider's key, or the balance key
  at all, from its environment.
- Creating a session on a credentialed provider needs its `authTokenEnv`
  variable in the server environment (or global provider Settings), whatever
  host login exists: otherwise creation is refused with "Provider OpenRouter
  needs OPENROUTER_API_KEY in the server environment." Such sessions show no
  claude.ai login-expiry notice.

Use two OpenRouter keys: an **inference** key in `OPENROUTER_API_KEY` (create
it with a spending limit — the cap bounds what agents can spend), and,
optionally, a **management** key in `OPENROUTER_MANAGEMENT_KEY`, which can
create and delete keys and so must never reach an agent.

A user-level `providers.json` replaces both shipped files, so on a server
that has one, copy the entry there to offer OpenRouter:

```json
{
  "openrouter": {
    "label": "OpenRouter",
    "authTokenEnv": "OPENROUTER_API_KEY",
    "balanceKeyEnv": "OPENROUTER_MANAGEMENT_KEY",
    "env": {
      "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "~anthropic/claude-opus-latest[1m]",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "~anthropic/claude-sonnet-latest[1m]",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "~anthropic/claude-haiku-latest",
      "ANTHROPIC_DEFAULT_FABLE_MODEL": "~anthropic/claude-opus-latest[1m]"
    },
    "models": {
      "openrouter-opus": { "label": "OpenRouter Opus", "model": "opus" },
      "openrouter-sonnet": { "label": "OpenRouter Sonnet", "model": "sonnet" },
      "openrouter-haiku": { "label": "OpenRouter Haiku", "model": "haiku" }
    }
  }
}
```

## Provider reset time zone

Some gateways put the limit reset in the error text without a zone (GLM:
`Your limit will reset at 2026-10-13 17:17:00`). A provider's
`limitResetTimeZone` — an IANA zone (`Asia/Shanghai`) or a fixed `±HH:MM`
offset; a legacy `profiles.json` entry carries one the same way — says how to
read it, so the provider's cooldown and parked work's resume use the real
reset instead of the one-hour fallback. A reset the provider announces itself
always wins; without the field the text is ignored.

```json
{ "glm": { "label": "GLM", "limitResetTimeZone": "Asia/Shanghai" } }
```

## Operator-named executables

A **user-level** catalog entry may name an `executable` launched in place of
the standard Claude Code binary — the trust model of `/usr/local/bin/claude-*`
wrappers, without hand-maintained shell scripts:

```json
{ "lan": { "label": "LAN", "executable": "/usr/local/bin/claude-lan" } }
```

The wrapper receives the merged base environment (credentials included); any
entry `env` is pre-applied and the wrapper's own exports win. No inline
controlled settings are injected for executable-backed profiles — the wrapper
owns its provider configuration, including any permission flags it passes
(operator trust). Catalog files discovered in the project tree cannot name
executables: they are agent-writable, and an executable there would run
arbitrary code with server credentials. A missing or non-executable path is
an actionable error before any agent starts.

Terminal commands are unaffected: kawai writes no executables, and existing
`claude-*` wrapper scripts remain yours to maintain or delete.

Resolution starts with the server environment, applies global provider
Settings (or AGENTBOARD_CHAT_ENV when no Settings override exists), then
cleans and applies named-profile controlled variables. Controlled variables
are routing, model and model aliases, attribution, and auto-compaction fields
listed in PROFILE_CONTROLLED_ENV. Named profiles neutralize conflicting
user/project/local environment settings through the SDK flag settings layer.
Prescribed startup models use options.model. Unrelated project settings and
instructions still load. Managed organization policies retain their authority.

Two deliberate Kimi deviations from [Moonshot's example](https://platform.kimi.ai/docs/guide/claude-code-kimi#configuration-reference):
Haiku stays on `kimi-k3[1m]`, not `kimi-k2.7-code`, which rejects requests
with thinking off (`400 invalid thinking`) while Haiku-tier background calls
can run with thinking off; and there is no `CLAUDE_CODE_SUBAGENT_MODEL` —
catalog files accept only profile-controlled variable names and any other
name rejects the whole file, while fully mapped tiers already resolve
subagents to `kimi-k3[1m]`. `CLAUDE_CODE_EFFORT_LEVEL` is never set: it is
not profile-controlled and would override kawai's group effort. The GLM
profiles map all four tiers explicitly: [Z.AI documents server-side
defaults only for Opus and Sonnet](https://docs.z.ai/scenario-example/develop-tools/claude),
so Haiku and Fable are pinned here too. MiMo's own page maps Sonnet to
`mimo-v2.6-pro`; kawai keeps Sonnet on `mimo-v2.6-flash`, its existing
mapping.

Default retains global provider configuration unchanged. Named profiles retain
credentials and unrelated runtime variables from it. Provide suitable API keys,
auth tokens, OAuth tokens, or an authenticated CLI configuration on the server
or through global provider Settings; credentials are not stored in the catalog
or included in metadata. Credential presence does not prove gateway acceptance.
A provider that names its own key variable (see [Provider credentials](#provider-credentials))
uses that key instead of the shared credentials.

`GET /api/chat/profiles?projectPath=…` returns a JSON object:
`{ profiles: [{id, label}, …], errors: [file failures, …] }`, resolved for
that project path (profile entries carry identifiers and labels only). A chat
WebSocket creation request may include `claudeProfileId`:

```json
{"type":"session-create","kind":"chat","projectPath":"/workspace/project","claudeProfileId":"glm"}
```

Older clients omit the field and use Default. Session-created, sessions, and
session-update metadata carry `claudeProfileId`; reconnects retain that
identity. Unknown IDs, terminal requests with a profile, and custom chat launch
maps or commands are refused. Tool approvals keep their existing behavior.

SQLite adds `chat_sessions.profile_id TEXT NOT NULL DEFAULT 'default'`.
Legacy rows migrate to Default; only the profile ID is persisted. Restart and
agent respawn resolve the stored profile against the current filesystem and
resume the same SDK conversation. Unknown stored profiles remain visible and
block sending until their catalog entry is restored (a renamed or deleted
`.kawai` file hits the same path). Catalog files are read per request and at
each spawn; global Settings changes apply at the next spawn; active processes
keep their launch settings.

Availability probes check the SDK control handshake under the resolved
profile environment, model, and inline settings, without sending a model turn.
Equal configurations share successful/in-flight probes; changed configurations
or failed probes are checked again. This is not a gateway connectivity check.

Env-based profiles configure routing and model environment, not the
executable: their chat sessions run the server-wide Claude Code executable,
resolved from `KAWAI_CLAUDE_PATH` or the server `PATH` and checked against
the 2.1.289 baseline before the handshake probe (see the README chat setup).
Profiles naming an `executable` run that wrapper instead; it is verified to
exist and be executable, but not baseline-checked. Upgrade the Agent SDK
package and the installed Claude Code together.

On rollback, retain the additive database column but stop named-profile
sessions first: older code would resume them under global provider settings.

Local verification: `bun scripts/verify-claude-profile-settings.ts` uses a
loopback mock provider and synthetic credentials to exercise real SDK
settings precedence. It does not contact the catalog's gateways.

`bun scripts/verify-claude-profile-resume.ts` additionally checks concurrent GLM/MiniMax sessions, tool approvals, and restart/resume with the same conversation IDs against loopback routes.
