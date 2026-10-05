# Tasks

## 1. Server: provider environment

- [x] 1.1 Add `src/server/chat/chatProviderEnv.ts` with `parseChatProviderEnv` (`KEY=VALUE;KEY=VALUE`), `validateChatProviderEnv`, and `buildChatOptionsEnv` (omit when empty, else spread `process.env` plus overrides); verify unit tests cover parsing, invalid names, empty values, and the omit/merge contract
- [x] 1.2 Read `AGENTBOARD_CHAT_ENV` into `config.chatProviderEnv`; verify a config unit test
- [x] 1.3 Pass the provider environment as SDK `env` from `ChatSessionDriver.spawnQuery()` and `probeSdkAvailability()`; verify driver tests assert `options.env` is absent by default and merged when configured
- [x] 1.4 Add `getProviderEnv` to `ChatSessionManager`, forward it to drivers and the probe, and evaluate `hasClaudeAuth` against the effective environment (adding `ANTHROPIC_AUTH_TOKEN`); verify manager tests cover forwarding and a provider-supplied credential

## 2. Server: persisted override

- [x] 2.1 Add `deleteAppSetting` to the database; verify a db unit test
- [x] 2.2 Boot-load `chat_provider_env` (else `AGENTBOARD_CHAT_ENV`) and add `GET`/`PUT` `/api/settings/chat-provider-env`, where PUT stores an override (an empty map included), DELETE restores the environment default, credential-looking values are redacted on GET, and invalid entries return 400; verify handler tests for read, write, clear, and refusal

## 3. Client: Settings

- [x] 3.1 Add a Claude Chat Provider section to `SettingsModal` with KEY=VALUE rows, add/remove, Apply, Reset to default, and an inline error; verify component tests for load, apply, clear, and server refusal

## 4. Docs and verification

- [x] 4.1 Document `AGENTBOARD_CHAT_ENV` and the Settings section in the README; verify lint, typecheck, unit tests, and the e2e suites pass
