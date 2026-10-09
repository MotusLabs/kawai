# Proposal

## Why

Chat sessions cannot be renamed: the server answers `session-rename` with "Chat
session rename is not available yet", even though the navigator already offers
the action. Meanwhile every chat session falls back to a random `adj-noun`
placeholder (`pure-bell`, `sure-mark`) while Claude Code has already written a
meaningful title into the session's transcript (`openspec-apply`, `Claude Code
Chat subscription usage metrics spec`). Users cannot fix the name by hand, and
the better name that already exists is never used.

## What Changes

- Let a user rename a chat session from the navigator and from the chat view
  header, with the change broadcast to every attached client.
- Give each chat session a name provenance — `manual`, `auto`, or `placeholder`
  — so the system knows whether a name was chosen by a person or merely
  generated.
- Adopt Claude Code's generated title (the `ai-title` row it writes into the
  session transcript) whenever the name is not `manual`, and keep following that
  title as the conversation retitles it.
- Keep a `manual` name sticky forever: a name set at creation or by a later
  rename is never overwritten by a generated title.
- Allow free-text chat names. Terminal names stay restricted to `[\w-]+` because
  they name tmux windows; generated titles contain spaces and punctuation, so
  that rule cannot apply to chat.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: adds requirements for chat session renaming, name
  provenance, and adopting the agent's generated title in place of a placeholder
  name.

## Impact

- `src/server/index.ts` — `handleRename` currently refuses chat sessions; it
  gains a chat branch and a relaxed name rule.
- `src/server/chat/ChatSessionManager.ts` — create/rename paths, and the
  provenance field on `ChatSessionRecord`.
- `src/server/chat/transcriptReplay.ts` — already parses the transcript; gains
  the `ai-title` rows it currently skips, plus a tail path for live sessions.
- `src/server/db.ts` — `chat_sessions` needs a provenance column and a migration
  for existing rows.
- `src/shared/types.ts` — `Session` carries name provenance so clients can tell
  a placeholder from a chosen name.
- `src/client/components/chat/ChatView.tsx` — header title becomes editable.
- `src/client/components/SessionRow.tsx` — rename entry point already exists and
  stops erroring for chat rows.

No new dependencies. Terminal (tmux) session naming is unchanged.
