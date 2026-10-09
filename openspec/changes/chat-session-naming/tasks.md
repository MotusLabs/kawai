# Tasks

## 1. Name provenance data model

- [x] 1.1 Add a `nameSource` field (`manual` | `auto` | `placeholder`) to `ChatSessionRecord` and to `Session` in `src/server/db.ts` and `src/shared/types.ts`, and verify `bun run typecheck` passes with the field threaded through `toSession`
- [x] 1.2 Add the `name_source` column to `chat_sessions` in `src/server/db.ts`, stamping each pre-existing row per design D6 — `placeholder` only when the name is a generator-shaped `adjective-noun` pair, `manual` otherwise — and verify unit tests cover both sides: `sure-mark` becomes `placeholder`, `show-chat-rate-limits` stays `manual`
- [x] 1.3 Persist and restore `nameSource` through `insertChatSession` / `updateChatSession`, and verify a round-trip test covers create, update, and `restorePersisted`

## 2. Chat session rename

- [x] 2.1 Add a rename path to `ChatSessionManager` that sets name plus `manual` provenance and propagates through `applyPatch`, and verify a unit test asserts the rename reaches db, registry, and the `session-update` broadcast
- [x] 2.2 Replace the chat refusal in `handleRename` (`src/server/index.ts`) with the chat rename path, applying trimmed-non-empty validation instead of the terminal `[\w-]+` rule, and verify tests cover free-text names with spaces and punctuation, empty-name refusal, and unknown-session refusal
- [x] 2.3 Confirm terminal and remote rename behavior is unchanged by its existing tests, and verify `bun run test` passes with those still green

## 3. Adopting generated titles

- [ ] 3.1 Parse `ai-title` and `custom-title` rows in `src/server/chat/transcriptReplay.ts` (currently skipped as unknown types), and verify unit tests cover both row shapes, a missing `aiTitle`, and a truncated trailing line
- [ ] 3.2 Implement a helper that returns the latest title and its implied source (`ai-title` → `auto`, `custom-title` → `manual`) from a transcript, and verify tests cover ordering when both appear
- [ ] 3.3 Tail the transcript of each live chat session for new title rows and apply them when provenance is not `manual`, and verify a test asserts a later `ai-title` updates an `auto` name and never touches a `manual` one
- [ ] 3.4 Release the tail on kill, archive, and shutdown, and verify a test asserts no watcher outlives the session
- [ ] 3.5 Read the title as a catch-up when a chat session is restored or first attached after a restart, and verify a test covers a session named before the feature adopting its transcript's title

## 4. Client rename surfaces

- [ ] 4.1 Make the chat view header name editable (`src/client/components/chat/ChatView.tsx`) and verify a component test covers editing, submitting, and the empty-name case
- [ ] 4.2 Wire the navigator rename entry point for chat rows (`src/client/components/SessionRow.tsx`) so it no longer errors, and verify a component test covers renaming a chat row and the name appearing on the row
- [ ] 4.3 Render an updated name on `session-update` without a reload, and verify a test asserts an attached client's header and row follow the broadcast

## 5. Integration verification

- [ ] 5.1 Run `bun run lint && bun run typecheck && bun run test` and verify all three pass
- [ ] 5.2 Start the app and verify end to end that a chat created without a name starts on a placeholder, adopts Claude's generated title while unclaimed, keeps a manual rename against later titles, and shows the name in the navigator without opening the chat

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
