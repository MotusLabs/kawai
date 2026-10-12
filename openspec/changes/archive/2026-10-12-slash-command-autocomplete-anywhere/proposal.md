# Proposal

## Why

The chat composer's slash-command menu opens only when the whole message is a
bare `/command`, so a user who wants to reference a command or skill partway
through a prompt (`please run /review on this`, or a second line starting with
`/`) gets no completion and has to remember exact names. Claude Code's own
prompt completes `/` wherever a word starts; Kawai's composer should too.

## What Changes

- The composer opens the slash-command menu for the `/word` at the caret
  wherever it sits in the message: at the start of the text, or after a space,
  tab, or newline. It stays closed for a `/` inside a word (`a/b`,
  `https://…`) and closes once the word holds a second `/` (a path such as
  `/usr/bin`), whitespace, or the caret moves out of it.
- The menu filters by that word only, with the existing ranking, keyboard,
  pointer, loading, and dismiss behavior.
- Choosing a command replaces only that word with `/<name> `, keeps the rest of
  the message intact, and leaves the caret just after the inserted command.
- The argument hint follows the `/<name> ` directly before the caret, not only a
  message that is exactly `/<name> `.
- Sending is unchanged: the message is sent as typed. A command in the middle of
  a message is prompt text for the agent, not a command Kawai runs; `/clear`,
  `/reset`, and `/new` still create a new chat only when they are the whole
  message.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-sessions`: the "composer offers a slash-command menu" requirement opens
  the menu for a `/` word at the caret anywhere in the message, not only for a
  message that starts with `/`, and inserts the chosen command in place.

## Impact

- Client only: `src/client/components/chat/slashCommandFilter.ts` (caret-aware
  token detection and in-place insertion), `ChatView.tsx` (caret tracking,
  menu open condition, insertion, argument hint), and their tests in
  `src/client/__tests__/slashCommandFilter.test.ts` and
  `chatComponents.test.tsx`.
- No server, protocol, or persistence change; `ChatCommand` and the
  `chat-commands` messages are untouched.
- Docs: the slash-command lines in `CLAUDE.md` and the header comments of the
  touched files.
