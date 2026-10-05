# Design

## Context

See proposal.md for motivation. The installed SDK is `@anthropic-ai/claude-agent-sdk` 0.3.289. Base chat creation, persistence, resume, new-session UI, and WebSocket integration are implemented; `claude-sdk-chat-sessions` is archived. The integrated `chat-provider-env` change adds global provider overrides seeded from AGENTBOARD_CHAT_ENV, a persisted Settings override, and credential-redacted Settings responses. `ChatSessionDriver.spawnQuery()` already passes the merged environment via `buildChatOptionsEnv`; it preserves cwd, Claude Code prompt, user/project/local setting sources, default permissions, and the canUseTool bridge. It does not yet resolve session profiles or prescribe a startup model.

`hasClaudeAuth` already evaluates API keys, auth tokens, OAuth tokens, and CLI credential paths against the effective environment. `ChatSessionManager` reads the global provider configuration through a getter and caches successful availability probes by configuration, shares matching in-flight probes, and clears failed probes for retry. These are reusable foundations, not completed per-session profile behavior.

All installed provider commands are symlinks to `/usr/local/bin/claude-provider`, which dispatches on the invoked basename. Reading a symlink's contents alone therefore does not identify its effective profile. Only five basenames have branches. `claude-glm-flash` and direct `claude-provider` invocation fall into the error branch. Every working branch ends in `exec claude --dangerously-skip-permissions "$@"`.

Main specs contain the base `chat-sessions` capability. This separate additive capability builds on the integrated chat and global provider implementation; it does not revise archived base-chat artifacts.

## Goals / Non-Goals

**Goals:** Resolve provider settings through a typed server catalog; keep credentials server-side; isolate session launch environments; preserve approval callbacks and project configuration; retain stable profile IDs across resume.

**Non-Goals:** Runtime shell parsing or execution, arbitrary profile editing, automatic wrapper discovery, modifying system wrappers, per-profile credential storage, provider connectivity checks during creation, changing a live session's profile, or extending remote-host/terminal flows.

## Decisions

### 1. Explicit predefined catalog based on effective wrapper branches

Add `src/server/chat/ClaudeProfiles.ts` with stable IDs, labels, environment overrides, and optional startup models. This keeps deployments usable without `/usr/local/bin` wrappers and avoids executing scripts to discover configuration. Runtime wrapper parsing was rejected because basename case dispatch, shell expansion, and arbitrary script behavior are not a configuration format. Update catalog values deliberately when wrappers change.

| ID | Label | Environment overrides | Startup model |
| --- | --- | --- | --- |
| default | Default | None; preserve current inherited behavior | Unset |
| glm | GLM | ANTHROPIC_BASE_URL=https://zai.ruslan.casa/api/anthropic; ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3-flash[1m]; ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3[1m]; CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000 | sonnet |
| minimax | MiniMax | ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic; ANTHROPIC_MODEL=MiniMax-M3 | MiniMax-M3 |
| mimo | MiMo | ANTHROPIC_BASE_URL=https://xiaomi.ruslan.casa/anthropic; ANTHROPIC_MODEL=mimo-v2.6-pro; ANTHROPIC_DEFAULT_SONNET_MODEL=mimo-v2.6-flash; ANTHROPIC_DEFAULT_OPUS_MODEL=mimo-v2.6-pro | mimo-v2.6-pro |
| kimi | Kimi | ANTHROPIC_BASE_URL=https://kimi.ruslan.casa/ | Unset |
| lan | LAN | ANTHROPIC_BASE_URL=http://ai.lan:9292; CLAUDE_CODE_ATTRIBUTION_HEADER=0 | Unset |

GLM's explicit Sonnet startup is a proposed deterministic default, not an assignment in the wrapper. Kimi and LAN lack model assignments, so inventing a provider model would be incorrect. Exclude the broken GLM Flash alias and the provider helper from the initial catalog; do not infer model choices from filenames.

### 2. Backend-owned catalog and additive UI/wire fields

Expose `GET /api/chat/profiles` returning only `{id, label}` entries in catalog order. Use SDK-agnostic metadata types in `src/shared/chat.ts`. Add optional `claudeProfileId` to `session-create` and chat session metadata in `src/shared/types.ts`; the server is authoritative and omitted IDs resolve to default.

The chat branch of `NewSessionModal` loads metadata, offers an accessible Profile selector with Default initially selected, and submits the selected ID. Keep terminal presets independent. On load failure, display an error and retry control and block chat submission rather than guessing catalog contents. Display the stored profile label in the chat header, falling back to its ID if unavailable. No persisted global preference is needed for the initial scope.

Validate IDs in ChatSessionManager before DB/registry writes and before lazy launch. Do not accept env maps or commands from clients. Reject a profile field on terminal creation with an actionable error, avoiding misleading selections.

### 3. Session-scoped environment and explicit configuration precedence

Resolve the global provider environment through the existing store (persisted Settings override when present, otherwise AGENTBOARD_CHAT_ENV). Precedence is process.env, then the global provider overrides, then named-profile cleanup and overrides. For named profiles, copy that effective environment, remove catalog-controlled variables, then overlay the selected profile. The controlled set includes ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_FABLE_MODEL, CLAUDE_CODE_ATTRIBUTION_HEADER, and CLAUDE_CODE_AUTO_COMPACT_WINDOW. Keep credentials, PATH, HOME, CLAUDE_CONFIG_DIR, and unrelated variables. Never mutate process.env. Default preserves the current global provider path without sanitization: omit options.env when no global overrides exist, otherwise use the existing merged environment. Read global settings at each new process launch; active processes retain their launch configuration.

Reuse the existing environment helpers and driver getter plumbing, extending them with session-profile resolution rather than adding a competing global provider store. Pass the resolved environment to options.env and prescribed startup model to options.model in the driver. Installed SDK types say an explicit env replaces the subprocess environment, so always carry inherited runtime variables. Preserve permissionMode=default, canUseTool, prompt configuration, and settingSources. Never forward the wrapper's permission-bypass flag or use the wrapper as the SDK executable.

Loaded Claude settings can contain env/model fields and may override subprocess variables. Use the installed SDK's inline options.settings to enforce named-profile values for controlled env fields while neutralizing conflicting lower-scope values for the remaining controlled fields. Preserve unrelated settings and project instructions. Explicit options.model wins for prescribed models; Kimi/LAN retain normal model selection from Claude settings after removing inherited profile model variables. Add a subprocess configuration smoke check using conflicting settings to verify neutralization with the bundled CLI; checking fake query options alone cannot establish actual precedence. Managed organization settings retain their documented authority; report restrictions rather than bypassing them.

Do not alter compaction based on assumptions about provider capacity. The GLM profile reproduces the wrapper's 1M intent; gateway acceptance is a separate operational concern.

### 4. Stable persistence and resume

Add `profile_id TEXT NOT NULL DEFAULT 'default'` to chat_sessions with the existing additive migration pattern. Extend ChatSessionRecord, insert/read/update mapping, and session metadata conversion. Store the ID only; no secrets or full process environment snapshots. Pass profile resolution through ensureDriver and retain it on driver respawn. For restored unknown IDs, keep the record/SDK ID and report an actionable error on send; never fall back to another provider.

Catalog edits apply on next driver launch, including restart; active processes keep their launch settings. This is deliberately profile identity persistence, not immutable configuration versioning. Existing SDK IDs and transcript-resume behavior remain owned by the base chat change.

### 5. Authentication checks use effective configuration

Reuse and adapt the existing hasClaudeAuth helper to evaluate the final resolved session environment for create and launch. Preserve its support for nonempty ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, and CLI login credentials under the effective CLAUDE_CONFIG_DIR. Credentials may come from process.env or the global provider configuration; named profiles retain them. This check confirms credentials are configured, not that a gateway will accept them. Profiles contain no secrets and do not suppress provider errors. A gateway with distinct credentials must be supplied suitable credentials through the backend environment or global provider Settings; per-profile credential management is outside scope.

### 6. Availability probes use resolved session configuration

Extend the existing configuration-keyed availability cache to probe the selected profile's resolved environment with the same startup model and inline controlled settings used by its session launch. Key the cache by all resolved launch settings that affect the probe, not merely profile ID or global overrides. Equal configurations share an in-flight/successful probe; different configurations do not reuse it, and failures are cleared for retry. Preserve the bounded control-handshake probe: no model turn or gateway connectivity test is added during creation. Default retains the existing probe behavior.

## Risks / Trade-offs

- Catalog drifts from wrappers → Document its source and cover every supported mapping with tests; updates are explicit reviewed changes.
- Settings precedence differs across SDK versions → Pin existing SDK, verify bundled-process behavior with conflicting config, and keep routing/model resolution in one module.
- Gateway model/context incompatibility → Preserve provider error text without credentials; document that 1M configuration does not expand model capacity.
- Backend credentials may not work for every provider → Check configured auth consistently and surface runtime authentication errors; do not add secrets to metadata.
- The profile planning branch predates integrated global provider settings → Bring its implementation baseline up to current master before applying tasks; reuse current interfaces and preserve the Settings API.

## Migration Plan

Implement on the current master baseline containing base chat and chat-provider-env. Add the defaulted DB column before reading/writing profile IDs, then ship backend contracts/catalog and frontend selection. Old clients omit IDs and existing rows remain Default. Roll back application code while retaining the harmless additive column; stop named-profile sessions before rollback because older code would resume them with inherited settings. No infrastructure deployment is part of this change.
