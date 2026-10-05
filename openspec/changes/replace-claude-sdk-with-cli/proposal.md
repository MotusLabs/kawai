# Proposal

## Why

Kawai already has a partially implemented chat driver backed by the TypeScript Claude Agent SDK, but the SDK delegates execution to the Claude Code CLI. Using the CLI protocol directly removes the SDK dependency and gives Kawai explicit control over process lifecycle and approvals while retaining Claude Code's tools and conversation engine.

## Recommendation and Decision Gate

Retaining the current TypeScript SDK is recommended until a concrete missing capability or measured operational benefit justifies replacement. No missing SDK feature has been established by the source analysis. This proposal is a reviewable replacement alternative, not evidence that replacement is necessary. Before implementation, document the gap, evaluate documented SDK options and a narrow patch/upstream extension, and obtain an explicit decision to proceed with full replacement. Independent direct writes to an SDK-owned process are not proposed.

## What Changes

- Replace the SDK query factory with a Bun subprocess adapter using bidirectional newline-delimited JSON.
- Preserve chat streaming, approvals, AskUserQuestion, interrupts, transcript replay, and conversation resume through the existing chat contracts.
- Make the Claude Code executable an explicit runtime prerequisite, with executable selection, bounded compatibility checks, and actionable session-scoped failures. Removing the SDK also removes its bundled CLI; installations must provide Claude Code separately.
- Remove SDK imports and dependency after driver and manager parity tests pass; retain existing persisted conversation IDs and database field names.
- Keep per-session launch environment, model, and settings configuration compatible with the separately planned provider profiles.
- Treat this as a follow-up to `claude-sdk-chat-sessions`. Its SDK transport decision is superseded when this change is applied; its user-facing acceptance criteria remain authoritative. `claude-sdk-session-profiles` must use the resulting launch contract if applied afterward.

## Capabilities

### New Capabilities

- `claude-runtime`: Direct Claude Code runtime availability, session execution, bidirectional controls, and process lifecycle guarantees.

### Modified Capabilities

None. Main specs have no chat capability yet. The active `chat-sessions` delta remains owned by `claude-sdk-chat-sessions`; this change does not duplicate or rewrite its requirements.

## Impact

`src/server/chat/ChatSessionDriver.ts`, `ChatSessionManager.ts`, `TurnQueue.ts`, new CLI protocol/transport modules, chat unit tests and subprocess integration fixtures, `package.json` and Bun lockfile, and setup documentation. Existing client/WebSocket contracts and SQLite records remain compatible. Deployments need an independently installed Claude Code executable; infrastructure deployment itself is outside scope. No Python dependency, model HTTP API implementation, authentication extraction, or Claude Code engine reimplementation is proposed.
