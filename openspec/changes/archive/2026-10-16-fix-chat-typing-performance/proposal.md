# Proposal

## Why

Typing is fast in a new chat but becomes slow in chats with history, as reported after deploying v1.0.0-1769. Composer edits currently re-render the transcript; the recently shipped author/time layout adds repeated date-formatter construction to the existing Markdown and tool rendering cost.

## What Changes

- Keep composer edits, caret movement, and slash-menu interaction independent of rendering unchanged conversation history.
- Reuse date formatters and avoid repeating transcript layout and unchanged Markdown work unnecessarily, including during live updates.
- Preserve the author/time layout, message ordering, expanded disclosures, per-session drafts, slash commands, and submission behavior.
- Add deterministic rendering regression coverage and a browser comparison using empty and long conversations, idle and streaming.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: require responsive composer editing independent of unchanged history, including while new conversation events arrive.

## Impact

Client chat composition and rendering in `ChatView`, `ChatMessages`, and `Markdown`, plus the deployed `chatTimeFormat`/`transcriptLayout` helpers and related tests. The current checkout predates those deployed helpers: implementation must use a baseline containing the shipped `chat-transcript-layout` change. No server protocol, database, provider, dependency, or deployment changes are required.
