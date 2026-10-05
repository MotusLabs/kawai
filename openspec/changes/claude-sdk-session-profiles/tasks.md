# Tasks

## 1. Profile catalog and launch configuration

- [ ] 1.1 Add the typed Default/GLM/MiniMax/MiMo/Kimi/LAN catalog and pure environment/model resolver in src/server/chat/ClaudeProfiles.ts; verify unit tests cover all observed wrapper assignments, omitted/unknown IDs, runtime-variable preservation, controlled-variable cleanup, and unchanged input environment.
- [ ] 1.2 Pass resolved per-session env/model/inline settings through ChatSessionDriver while retaining the existing approval bridge and project setting sources; verify driver tests capture expected options and concurrent GLM/MiniMax sessions cannot leak overrides.
- [ ] 1.3 Verify named-profile precedence with the installed SDK subprocess against a local mock Anthropic endpoint and temporary conflicting user/project settings; confirm routing, prescribed model, and alias mapping use the profile while unrelated project settings load, without contacting live providers.
- [ ] 1.4 Update configured-auth checks to use the resolved environment and accept auth tokens as well as API keys or CLI credentials; verify manager tests cover token-only, key-only, CLI-login, and missing-auth refusal with no session side effects.
- [ ] 1.5 Document the catalog, inherited credential requirements, controlled-variable precedence, Default behavior, 1M provider capacity limitation, and exclusion of broken GLM Flash/provider helper wrappers; verify documented mappings match catalog tests.

## 2. Durable session identity and server contracts

- [ ] 2.1 Add the defaulted chat_sessions.profile_id migration and record/query mappings; verify DB tests cover migration of an existing table, Default for legacy rows, and named-profile round trips.
- [ ] 2.2 Extend shared SDK-agnostic metadata, session-create, manager records, and registry broadcasts with claudeProfileId; verify manager tests cover omitted/default IDs, unknown-ID refusal, metadata updates, and no changes to terminal creation without a profile.
- [ ] 2.3 Resolve persisted profiles on first launch, process respawn, and restart resume; verify manager tests retain selected profiles and SDK conversation IDs and refuse unknown stored profiles without deleting records or launching a default provider.
- [ ] 2.4 Add GET /api/chat/profiles and wire chat creation through the existing WS path; verify route/WS tests return identifiers and labels only, reject arbitrary profile configuration and terminal requests carrying a profile, and preserve the base chat protocol.
- [ ] 2.5 Document the profile metadata and additive create/session fields plus migration and rollback behavior; verify examples match route/WS tests and legacy clients still omit the field successfully.

## 3. Profile selection and session display

- [ ] 3.1 Add catalog loading and an accessible chat-only Profile selector to NewSessionModal with Default selected initially; verify component tests cover selections, outgoing profile IDs, loading/error/retry behavior, and unchanged terminal command presets.
- [ ] 3.2 Display the session's profile in the chat header using catalog labels with an ID fallback; verify component/store tests cover named profiles, legacy Default sessions, reconnect snapshots, and an unavailable stored profile.
- [ ] 3.3 Document how to select a chat profile and recognize the active selection; verify the documented labels and default match the UI.

## 4. Integration validation

- [ ] 4.1 Run bun run lint && bun run typecheck && bun run test and verify all required checks pass after the profile changes are integrated with claude-sdk-chat-sessions.
- [ ] 4.2 Use the dev-browser skill for browser verification, searching for it if absent; if unavailable, explicitly report that limitation and use Playwright as the fallback. Start the app, capture screenshots, and verify DOM state for chat profile selection, create/display/reconnect, catalog failure, and terminal regression; retain observable verification evidence.
- [ ] 4.3 Exercise two concurrent named-profile chat sessions and restart/resume against a local mock provider; verify captured requests route to their selected configuration, approval cards still work, and credentials never appear in profile/session metadata.
