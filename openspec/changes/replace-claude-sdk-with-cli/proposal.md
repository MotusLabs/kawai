# Proposal

## Why

Kawai already has an implemented chat driver backed by the TypeScript Claude Agent SDK, but the SDK delegates execution to the Claude Code CLI. Using the CLI protocol directly removes the SDK dependency and gives Kawai explicit control over process lifecycle and approvals while retaining Claude Code's tools and conversation engine.

## Recommendation and Decision Gate

Retaining the current TypeScript SDK is recommended until a concrete missing capability or measured operational benefit justifies replacement. No missing SDK feature has been established by the source analysis. This proposal is a reviewable replacement alternative, not evidence that replacement is necessary. Before implementation, document the gap, evaluate documented SDK options and a narrow patch/upstream extension, and obtain an explicit decision to proceed with full replacement. Independent direct writes to an SDK-owned process are not proposed.

## What Changes

- Replace the SDK query factory with a Bun subprocess adapter using bidirectional newline-delimited JSON.
- Preserve chat streaming, approvals, AskUserQuestion, interrupts, transcript replay, conversation resume, and raw protocol capture for the debug view through the existing chat contracts.
- Make the Claude Code executable an explicit runtime prerequisite, with executable selection, bounded compatibility checks, and actionable session-scoped failures. Removing the SDK also removes its bundled CLI; installations must provide Claude Code separately.
- Remove SDK imports and dependency after driver and manager parity tests pass; retain existing persisted conversation IDs and database field names.
- Keep per-session launch environment, model, and settings configuration compatible with the provider profiles implemented in PR #15.
- Treat this as a follow-up to the implemented chat integration and provider profiles. Its SDK transport decision is superseded only when this change is applied; the main `chat-sessions`, `claude-session-profiles`, and `chat-debug` acceptance criteria remain authoritative.

## Capabilities

### New Capabilities

- `claude-runtime`: Direct Claude Code runtime availability, session execution, bidirectional controls, and process lifecycle guarantees.

### Modified Capabilities

None. Existing chat, provider-profile, and debug requirements remain authoritative; this change adds a runtime capability without duplicating them. Applying the replacement must reconcile SDK-specific wording in the main specs without changing their user-facing behavior.

## Impact

`src/server/chat/ChatSessionDriver.ts`, `ChatSessionManager.ts`, `TurnQueue.ts`, new CLI protocol/transport modules, chat unit tests and subprocess integration fixtures, `package.json` and Bun lockfile, and setup documentation. Existing client/WebSocket contracts and SQLite records remain compatible. Deployments need an independently installed Claude Code executable; infrastructure deployment itself is outside scope. No Python dependency, model HTTP API implementation, authentication extraction, or Claude Code engine reimplementation is proposed.
