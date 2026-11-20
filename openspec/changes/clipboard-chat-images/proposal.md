# Proposal

## Why

Users need to show agents screenshots, diagrams, and visual failures directly from the clipboard. Chat sessions currently accept text only, even though the terminal view already supports image paste and both agent runtimes expose image input types.

## What Changes

- Paste one or more clipboard images into the chat composer with Ctrl+V / Cmd+V or the browser's Paste action; show ordered thumbnails with accessible remove controls.
- Send images with optional text, including image-only messages, to both Claude Agent SDK and Codex app-server sessions as native image inputs.
- Keep image drafts isolated per session through navigation and reconnects; upload only when Send is requested.
- Store uploaded images durably and render them with the user message in live, reconnected, restarted, paginated, and archived conversation views.
- Validate uploads and session ownership, keep image bytes outside chat WebSocket messages, and explain failures without discarding the user's draft or automatically resending uncertain submissions.

## Capabilities

### New Capabilities

- `chat-image-attachments`: Clipboard ingestion, draft previews, validated image submission to either runtime, durable image assets, and conversation rendering/replay.

### Modified Capabilities

None. The new capability extends the existing chat send and history surfaces. Existing text draft, slash-command, archive, and transcript requirements continue to apply; image drafts remain client-local until the user requests Send.

## Impact

- Client: `ChatComposer`, `ChatSurface`, `chatStore`, shared submit/recovery state, `ChatMessages` and user rows; ordinary and embedded plan-workspace hosts.
- Protocol: additive image references on `chat-send` and `user_message`, using the existing correlated send-result/refusal path.
- Server: session-scoped HTTP upload/asset routes, a durable image store beside the configured database, manager/driver input handling, Claude transcript replay, and Codex rollout replay.
- Tests: clipboard/composer and draft lifecycle, production route wiring and validation, both provider payloads, transcript replay, and browser paste flows. Architecture documentation updated during implementation.
- Existing terminal paste routes remain available. No new runtime dependency is planned.

## Non-goals

File picker or drag-and-drop UI, arbitrary file attachments, OCR preprocessing, image editing, remote image URL ingestion, copying images out of transcript rows, attachments in team mail, and unsent draft recovery after a page reload. Supporting Claude and Codex transports does not promise vision support in every third-party model profile.
