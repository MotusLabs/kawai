# Claude chat profiles

In New Session, choose **Claude chat**, then select **Profile**. Default is
selected initially. The offered catalog follows the entered project path (see
below). The chat header shows the selected profile. Catalog load failures
block creation and offer **Retry profiles**; terminal command presets are
independent.

The shipped default catalog:

| ID | Label | Routing and models |
| --- | --- | --- |
| default | Default | Existing server environment and global provider Settings |
| glm | GLM | `https://zai.ruslan.casa/api/anthropic`; starts on Sonnet, mapped to `glm-5.3-flash[1m]`; Opus maps to `glm-5.3[1m]`; auto-compact window `1000000` |
| minimax | MiniMax | `https://api.minimax.io/anthropic`; `MiniMax-M3` |
| mimo | MiMo | `https://xiaomi.ruslan.casa/anthropic`; starts on `mimo-v2.6-pro`; Sonnet maps to `mimo-v2.6-flash`, Opus to `mimo-v2.6-pro` |
| kimi | Kimi | `https://kimi.ruslan.casa/`; no prescribed model |
| lan | LAN | `http://ai.lan:9292`; attribution header disabled; no prescribed model |

## Catalog files

Profiles are defined in `profiles.json` files inside `.kawai` directories,
layered like Claude Code settings. For a chat session, the server collects
every `.kawai/profiles.json` from the session's project path up to the
filesystem root, above a user-level `~/.kawai/profiles.json` that replaces the
shipped default (`config/profiles.default.json`) when present — in container
deployments, mount the user-level file (ConfigMap) or bake an image default.

Entries with the same id merge per environment key: the nearest file wins,
and an empty value neutralizes an inherited value. Scalar fields (`label`,
`model`) follow nearest-set-wins; `label` falls back to the profile id. The
`default` profile is definable in files and always exists (implicit and empty
when no file defines it — global provider configuration alone). Home-relative
project paths (`~/work/app`, as typed in New Session) expand to the server
home before discovery, so the picker and creation read the same files.

```json
{
  "glm-flash": {
    "label": "GLM Flash",
    "model": "glm-5.3-flash[1m]",
    "env": { "ANTHROPIC_BASE_URL": "https://zai.ruslan.casa/api/anthropic" }
  }
}
```

Catalog `env` keys are restricted to the profile-controlled variables
(PROFILE_CONTROLLED_ENV): routing, models, attribution, compaction.
Credentials are never allowed in catalog files; they enter sessions only
through the server environment or global provider Settings, so catalog files
stay safe to commit and mount. A file that fails validation is skipped, and
the rest of the catalog still resolves — the failure is never silent: the
picker shows it as a warning next to the profile list, and every launch
resolution logs it (`chat_profile_catalog_errors` in agentboard.log).

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
Prescribed startup models use options.model. Kimi and LAN retain normal model
selection from Claude settings. Unrelated project settings and instructions
still load. Managed organization policies retain their authority.

Default retains global provider configuration unchanged. Named profiles retain
credentials and unrelated runtime variables from it. Provide suitable API keys,
auth tokens, OAuth tokens, or an authenticated CLI configuration on the server
or through global provider Settings; credentials are not stored in the catalog
or included in metadata. Credential presence does not prove gateway acceptance.
Per-profile credential management is outside this feature.

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
