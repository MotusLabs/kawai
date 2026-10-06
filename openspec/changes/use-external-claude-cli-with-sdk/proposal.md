# Proposal

## Why

Chat sessions run Claude Code through the Agent SDK's bundled native CLI, which is installed as ~464 MB of platform packages (glibc and musl both install on linux-x64) and drifts from the operator's installed `claude`. Released Kawai binaries are `bun build --compile` executables that do not embed those packages, so the SDK's bundled-binary lookup fails and chat is unavailable in releases. The SDK's supported `pathToClaudeCodeExecutable` option fixes both while keeping the SDK; the measurements behind this choice are in `openspec/changes/replace-claude-sdk-with-cli/decision.md`.

## What Changes

- Chat sessions and the availability probe launch a separately installed Claude Code executable through `pathToClaudeCodeExecutable`, selected from server-only `KAWAI_CLAUDE_PATH` or `claude` on `PATH`.
- A bounded `--version` probe enforces the SDK's tested baseline (`claudeCodeVersion` 2.1.289 for SDK 0.3.289) before the existing control-handshake probe; missing, non-executable, and too-old executables refuse chat creation with actionable errors. Terminal sessions and backend startup are unaffected.
- **BREAKING (installation)**: the SDK's platform CLI packages are no longer installed — `package.json` overrides map them to an empty local stub. Development, CI, and release hosts that run chat sessions must have Claude Code installed separately.
- Setup docs describe the separate install, tested baseline, executable selection, and rollback.
- The SDK, its protocol handling, wire capture, profiles, persisted IDs, and WebSocket contracts are unchanged. The full-replacement change `replace-claude-sdk-with-cli` is superseded and should be withdrawn once this is verified.

## Capabilities

### New Capabilities

- `claude-executable`: selection, compatibility checking, and failure reporting for the Claude Code executable that chat sessions run.

### Modified Capabilities

None. Chat-session, profile, and debug requirements keep their behavior; the existing availability probe gains executable checks defined in the new capability.

## Impact

`package.json`, `bun.lock`, a new empty stub package directory, `src/server/chat/sdkAvailability.ts`, `ChatSessionDriver.ts` (launch options), `ChatSessionManager.ts` (probe/errors), a new executable-resolution module with tests, README and `docs/claude-session-profiles.md`. CI chat tests use injected fakes and need no CLI. Release binaries gain working chat when Claude Code is installed on the host. No database or client changes.
