# Proposal

## Why

Typing a slash command in a Kawai chat already reaches Claude Code, but users have no way to discover which commands exist, and local commands such as `/context`, `/cost`, `/model`, or `/compact` produce output that the chat silently drops. The command list Claude Code reports only exists after the agent process starts, which today happens on the first message, too late for a command menu.

## What Changes

- Start a chat session's agent process when a client attaches to it, without sending a prompt, so its command list is available before the first message. Archived chats and chats whose project directory is missing still start nothing.
- Deliver the session's slash-command list (name, description, argument hint, aliases, and whether it is a project or user command) to clients in the chat snapshot and as live updates when Claude Code reports a changed list, with a loading, ready, or unavailable state.
- Add a command menu to the chat composer: typing `/` at the start of the message opens a filtered list; choosing a command inserts it with its argument hint instead of sending it. Commands bound to a terminal, and internal commands, are not offered.
- Show local command output in the transcript instead of dropping it.
- Show slash-command turns in replayed history as the command the user typed and its output, not as raw command markup.
- Make `/clear`, `/reset`, and `/new [name]` start a new chat in the same project with the same profile (named when a name is given), select it, then archive the previous chat. If the new chat cannot be created, the current chat is left unchanged.
- Update the in-flight `replace-claude-sdk-with-cli` design so its transport performs the handshake on attach and preserves the command list from the initialize response.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: agent start on attach, the slash-command list and composer menu, local command output, slash-command rendering in replayed history, and `/clear` mapped to new chat plus archive.

## Impact

- Server: `src/server/chat/ChatSessionManager.ts` and `ChatConnections.ts` (start on attach through the existing archived/missing-directory guards, command list in snapshots and pushes), `ChatSessionDriver.ts` (start without a prompt, handle `local_command_output`, `commands_changed`, and `init` terminal commands), a new small module for command-list state, `transcriptReplay.ts` (command markup).
- Shared: `src/shared/chat.ts` and `src/shared/types.ts` (command type, snapshot field, `chat-commands` server message).
- Client: `src/client/stores/chatStore.ts`, `src/client/components/chat/ChatView.tsx`, a new composer command menu component.
- Planning: `openspec/changes/replace-claude-sdk-with-cli/design.md` (Decision 2).
- Runtime: an agent process now runs for every chat that has been opened since server start, not only for chats that received a message.
