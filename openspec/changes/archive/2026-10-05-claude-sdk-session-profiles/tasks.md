# Tasks

## Implementation baseline

Base chat and global chat-provider-env are integrated on master. Bring this planning branch up to that baseline before implementing. Global environment merge, credential-aware auth, Settings persistence/redaction, and configuration-keyed retryable availability probes already exist. These foundations do not themselves complete any task below; the tasks track per-session profile behavior and its verification.

## 1. Profile catalog and launch configuration

- [x] 1.1 Add the typed Default/GLM/MiniMax/MiMo/Kimi/LAN catalog and pure environment/model resolver in src/server/chat/ClaudeProfiles.ts; verify unit tests cover all observed wrapper assignments, omitted/unknown IDs, runtime-variable preservation, controlled-variable cleanup, and unchanged input environment.
- [x] 1.2 Extend the existing provider getter and environment helpers to pass resolved per-session env/model/inline settings through ChatSessionDriver while retaining the existing approval bridge and project setting sources; verify driver tests capture expected options and concurrent GLM/MiniMax sessions cannot leak overrides.
- [x] 1.3 Verify named-profile precedence with the installed SDK subprocess against a local mock Anthropic endpoint and temporary conflicting user/project settings; confirm routing, prescribed model, and alias mapping use the profile while unrelated project settings load, without contacting live providers.
- [x] 1.4 Reuse the existing effective-environment hasClaudeAuth helper (API key, auth token, OAuth token, and CLI login support already implemented), extending create and launch checks to the final resolved session environment; verify manager tests cover credentials from global Settings, profile resolution, OAuth support, and missing-auth refusal with no session side effects.
- [x] 1.5 Document the catalog, inherited credential requirements, controlled-variable precedence, Default behavior, 1M provider capacity limitation, and exclusion of broken GLM Flash/provider helper wrappers; verify documented mappings match catalog tests.

- [x] 1.6 Extend the existing availability probe and cache to use resolved per-session environment, startup model, and inline controlled settings; verify tests cover Default/global settings, distinct profile configurations, shared concurrent probes, global-setting changes, and recovery after failure without a model turn.

## 2. Durable session identity and server contracts

- [x] 2.1 Add the defaulted chat_sessions.profile_id migration and record/query mappings; verify DB tests cover migration of an existing table, Default for legacy rows, and named-profile round trips.
- [x] 2.2 Extend shared SDK-agnostic metadata, session-create, manager records, and registry broadcasts with claudeProfileId; verify manager tests cover omitted/default IDs, unknown-ID refusal, metadata updates, and no changes to terminal creation without a profile.
- [x] 2.3 Resolve persisted profiles on first launch, process respawn, and restart resume; verify manager tests retain selected profiles and SDK conversation IDs and refuse unknown stored profiles without deleting records or launching a default provider.
- [x] 2.4 Add GET /api/chat/profiles and wire chat creation through the existing WS path; verify route/WS tests return identifiers and labels only, reject arbitrary profile configuration and terminal requests carrying a profile, and preserve the base chat protocol.
- [x] 2.5 Document the profile metadata and additive create/session fields plus migration and rollback behavior; verify examples match route/WS tests and legacy clients still omit the field successfully.

## 3. Profile selection and session display

- [x] 3.1 Add catalog loading and an accessible chat-only Profile selector to NewSessionModal with Default selected initially; verify component tests cover selections, outgoing profile IDs, loading/error/retry behavior, and unchanged terminal command presets.
- [x] 3.2 Display the session's profile in the chat header using catalog labels with an ID fallback; verify component/store tests cover named profiles, legacy Default sessions, reconnect snapshots, and an unavailable stored profile.
- [x] 3.3 Document how to select a chat profile and recognize the active selection; verify the documented labels and default match the UI.

## 4. Integration validation

- [x] 4.1 Run bun run lint && bun run typecheck && bun run test and verify all required checks pass after the profile changes are integrated with the existing chat and global provider implementation.
- [x] 4.2 Use the dev-browser skill for browser verification, searching for it if absent; if unavailable, explicitly report that limitation and use Playwright as the fallback. Start the app, capture screenshots, and verify DOM state for chat profile selection, create/display/reconnect, catalog failure, and terminal regression; retain observable verification evidence.
- [x] 4.3 Exercise two concurrent named-profile chat sessions and restart/resume against a local mock provider; verify captured requests route to their selected configuration, approval cards still work, and credentials never appear in profile/session metadata.
