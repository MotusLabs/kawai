# Tasks

## 1. Wire contract and storage

- [x] 1.1 Add `model: string | null` to the `chat-snapshot` payload and the additive `chat-model` server message in `src/shared/types.ts` (and any shared typing it needs), then verify `bun run typecheck` passes
- [x] 1.2 Add the nullable `model` column to `chat_sessions` in `src/server/db.ts` (migration, record read/write, patch support), then verify a persistence test modeled on `src/server/__tests__/chatContextDb.test.ts` passes: patch persists, reload maps back, pre-existing rows read null

## 2. Server capture and fan-out

- [x] 2.1 In `src/server/chat/ChatSessionDriver.ts`, capture the `model` string of every `system/init` frame in `handleSystem`, fire a new optional `onModel` callback only for non-empty values that differ from the last fired one, and verify `src/server/__tests__/chatSessionDriver.test.ts` covers: first init fires, same model on next turn does not re-fire, a changed model re-fires, empty/missing model never fires
- [x] 2.2 Wire `onModel` through `ChatSessionManager`: store the value in memory, include it in `getSnapshot` (in-memory wins over the stored column, `null` before any report), persist via the session patch path, and hand the change to connections, then verify `src/server/__tests__/chatSessionManager.test.ts` covers snapshot fallback to the stored value and push-on-change only
- [x] 2.3 Add the per-session coalesced `chat-model` batch to `ChatConnections.ts` (flush pattern of `chat-context-usage`) and verify `src/server/__tests__/chatConnections.test.ts` covers: subscribed connections receive the latest value once per flush, unsubscribed ones receive nothing

## 3. Client display

- [x] 3.1 Add `model: string | null` to the chatStore transcript state with snapshot adoption and a `chat-model` case, then verify `src/client/__tests__/chatStore.test.ts` covers: snapshot seeds it, a push replaces it, reconnect keeps the latest value
- [x] 3.2 Render the model in the `ChatView` header beside the context meter as a `text-chat-meta text-secondary` span (`data-testid="chat-model"`, exact string in `title`), rendering nothing while null, then verify `src/client/__tests__/chatComponents.test.tsx` covers: absent before any report, present after, archived chat renders the stored value without updates

## 4. Integration verification

- [x] 4.1 Run `bun run lint && bun run typecheck && bun run test` and fix anything this change introduced
- [x] 4.2 Start the dev fixture (`bun run dev` with the development fixture enabled) and verify in a browser that the header badge appears with the fixture's `claude-sonnet-4-5` once its first fake turn starts, and that the header's profile, status, and context meter are unaffected

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
