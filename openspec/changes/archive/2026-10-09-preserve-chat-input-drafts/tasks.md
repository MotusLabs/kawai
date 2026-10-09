# Tasks

## 1. Store

- [x] 1.1 Add a top-level `drafts: Record<string, string>` map and `setDraft(sessionId, text)` to `useChatStore` in `src/client/stores/chatStore.ts` (design D1): setDraft writes the value and deletes the key when `text` is `''`; the existing `remove()` also deletes the session's draft entry. Update the file's header comment. Verify in `src/client/__tests__/chatStore.test.ts` with cases for set, overwrite, clear-to-empty deleting the key, `remove()` discarding the draft, and `apply()`/`snapshot()` leaving `drafts` untouched

## 2. Composer

- [x] 2.1 Rewire the composer in `src/client/components/chat/ChatView.tsx` (design D2): read `useChatStore(state => state.drafts[session.id] ?? '')`, call `setDraft(session.id, value)` from `onChange`, and on submit send the trimmed text then `setDraft(session.id, '')`. Delete the local `text` state and the `useEffect(() => setText(''), [session.id])` clear. Update the file's header comment. Verify in `src/client/__tests__/chatComponents.test.tsx`: typing then re-rendering with another session's props shows that session's own draft, switching back restores the typed text, submitting clears only the submitting session's draft, and archived sessions still render no composer
- [x] 2.2 Extend the chat bullet in `CLAUDE.md` to note that unsubmitted composer input is kept per session (cleared on submit, discarded on kill, not persisted across reloads), and verify `bun run lint && bun run typecheck && bun run test` pass

## 3. Integration check

- [x] 3.1 Use the `dev-browser` skill against `bun run dev` with the development fixture: type an unsubmitted draft into one chat, switch to a second chat and type a different draft, switch back and confirm both composers kept their own text; submit in one and confirm only it cleared; archive a chat with a draft and confirm the draft returns after Restore; reload the page and confirm composers are empty. Save screenshots as evidence

## Workflow follow-up

- Commit each task group atomically on this branch (`preserve-chat-input-drafts`); push and open a PR only when asked.
- Archive the change with `/openspec-archive-change` after implementation and review are complete.
