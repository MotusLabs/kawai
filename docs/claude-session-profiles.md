# Claude chat profiles

In New Session, choose **Claude chat**, then select **Profile**. Default is
selected initially. The chat header shows the selected profile. Catalog load
failures block creation and offer **Retry profiles**; terminal command presets
are independent.

| ID | Label | Routing and models |
| --- | --- | --- |
| default | Default | Existing server environment and global provider Settings |
| glm | GLM | `https://zai.ruslan.casa/api/anthropic`; starts on Sonnet, mapped to `glm-5.3-flash[1m]`; Opus maps to `glm-5.3[1m]`; auto-compact window `1000000` |
| minimax | MiniMax | `https://api.minimax.io/anthropic`; `MiniMax-M3` |
| mimo | MiMo | `https://xiaomi.ruslan.casa/anthropic`; starts on `mimo-v2.6-pro`; Sonnet maps to `mimo-v2.6-flash`, Opus to `mimo-v2.6-pro` |
| kimi | Kimi | `https://kimi.ruslan.casa/`; no prescribed model |
| lan | LAN | `http://ai.lan:9292`; attribution header disabled; no prescribed model |

The catalog is maintained in `src/server/chat/ClaudeProfiles.ts`, derived from
the effective branches of `/usr/local/bin/claude-provider`. The application
never executes wrappers or imports their permission-bypass flag. GLM's Sonnet
startup is an explicit catalog default. GLM Flash and the helper command are
excluded because their installed wrapper basenames have no matching branch.
Update catalog mappings and tests together when providers change. A 1M window
setting requests that configuration; it does not increase provider capacity.

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

`GET /api/chat/profiles` returns a JSON array containing only `{id, label}`.
A chat WebSocket creation request may include `claudeProfileId`:

```json
{"type":"session-create","kind":"chat","projectPath":"/workspace/project","claudeProfileId":"glm"}
```

Older clients omit the field and use Default. Session-created, sessions, and
session-update metadata carry `claudeProfileId`; reconnects retain that
identity. Unknown IDs, terminal requests with a profile, and custom chat launch
maps or commands are refused. Tool approvals keep their existing behavior.

SQLite adds `chat_sessions.profile_id TEXT NOT NULL DEFAULT 'default'`.
Legacy rows migrate to Default; only the profile ID is persisted. Restart and
agent respawn resolve the stored profile and resume the same SDK conversation.
Unknown stored profiles remain visible and block sending until their catalog
entry is restored. Catalog and global Settings changes apply at the next
process launch; active processes keep their launch settings.

Availability probes check the SDK control handshake under the resolved
profile environment, model, and inline settings, without sending a model turn.
Equal configurations share successful/in-flight probes; changed configurations
or failed probes are checked again. This is not a gateway connectivity check.

On rollback, retain the additive database column but stop named-profile
sessions first: older code would resume them under global provider settings.

Local verification: `bun scripts/verify-claude-profile-settings.ts` uses a
loopback mock provider and synthetic credentials to exercise bundled SDK
settings precedence. It does not contact the catalog's gateways.

`bun scripts/verify-claude-profile-resume.ts` additionally checks concurrent GLM/MiniMax sessions, tool approvals, and restart/resume with the same conversation IDs against loopback routes.
