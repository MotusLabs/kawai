# Tasks

## 1. Caret-aware token helpers

- [x] 1.1 In `src/client/components/chat/slashCommandFilter.ts`, replace `SLASH_MENU_QUERY`/`slashMenuQuery` with `slashTokenAt(text, caret)` (design D1) and add `insertCommand(text, token, name)` (design D3); update the header comment; verify `bun run typecheck` reports no remaining callers of the removed exports
- [x] 1.2 Rewrite the `slashMenuQuery` cases in `src/client/__tests__/slashCommandFilter.test.ts` for `slashTokenAt`: start of text, after space/tab/newline, caret mid-word (`end` covers the rest of the word), `a/b`, `https://x`, `/usr/bin`, args typed, caret outside any word; and for `insertCommand`: empty message → `/name ` with caret at end, mid-message with following text keeps a single space, caret mid-word replaces the whole word; verify `bun run test src/client/__tests__/slashCommandFilter.test.ts` passes

## 2. Composer wiring

- [x] 2.1 In `ChatView.tsx`, track `caret` from `onChange`/`onSelect` (null for a non-collapsed selection, end of value when `selectionStart` is absent), derive the token, open/filter the menu from it, and reset highlight/dismiss when the token's start or query changes (design D2); verify the existing `slash-command menu` tests in `chatComponents.test.tsx` still pass unchanged
- [x] 2.2 Make choosing (Enter, Tab, click) call `insertCommand`, set text and caret, and restore the DOM caret through a textarea ref in a layout effect (design D3); verify with a component test that `please run /re on this` (caret after `/re`) becomes `please run /<name> on this` and no `chat-send` is sent
- [x] 2.3 Show the argument hint for the `/<name> ` directly before the caret (design D4); verify with a component test that the hint appears after a mid-message insertion and disappears once arguments are typed
- [x] 2.4 Add component tests for the remaining spec scenarios: menu opens mid-message and on a later line, stays closed for `and/or` and `/usr/bin`, closes when `onSelect` moves the caret out of the word or selects text and reopens when it returns, and sending `please run /clear later` sends it as a `chat-send` without `session-create`; verify `bun run test src/client/__tests__/chatComponents.test.tsx` passes
- [x] 2.5 Update the ChatView header comment and the slash-command bullet in `CLAUDE.md` to say the `/` menu opens for a `/` word at the caret anywhere in the message; verify by reading the diff

## 3. Integration check

- [x] 3.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [x] 3.2 Check the composer in the running app with the `dev-browser` skill: type a sentence, then ` /co`, choose a command with Enter, and verify by screenshot that the command is inserted in place with the caret after it and nothing was sent

## Workflow follow-up

- Archive the change after review, syncing the `chat-sessions` delta into the main spec.
