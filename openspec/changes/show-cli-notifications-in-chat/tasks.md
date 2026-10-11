# Tasks

## 1. Shared contracts

- [x] 1.1 Add `ChatNotification` (key, source, severity, priority, text, hint?, receivedAt) to `src/shared/chat.ts`. Add `notifications` to `chat-snapshot`, the `chat-notifications` server message, and the `chat-dismiss-notification` client message to `src/shared/types.ts`, each with a header comment that names the message additive and ephemeral. Verify with `bun run typecheck`, fixing every snapshot construction site and test fixture that now needs `notifications: []`.

## 2. Account notices (login expiry)

- [x] 2.1 Extract the config-dir resolution from `chatAuth.ts` into an exported helper, keeping `hasClaudeAuth` and its message the same. Verify the existing `chatAuth` tests still pass.
- [x] 2.2 Create `src/server/chat/accountNotices.ts` with `credentialsPathFor(env)` and `loginExpiryNotice(credentials, now)`, implementing the CLI rule from design D2. Add a header comment citing Claude Code 2.1.296. Verify with unit tests covering every scenario of "Expiring logins produce an account notice per profile": 1.4 days → "2 days", 5 h → "1 day", more than 3 days, expired, `expiresAt` beyond refresh + 3 days, each suppressing env var (API key, auth token, OAuth token, Bedrock, Vertex, Foundry), `CLAUDE_CONFIG_DIR` override, and missing, unreadable, malformed, or field-less files.
- [x] 2.3 Add `AccountNoticeStore`, keyed by credentials path, with `check(path)` and change-only subscriber notification. Verify with unit tests that unchanged results publish nothing, a new day count publishes, and a renewed login publishes null.

## 3. Agent notices

- [x] 3.1 In `ChatSessionDriver.handleSystem`, map `subtype === 'notification'` frames to `ChatNotification` (color → severity, per design D1) and pass them through a new `onNotification` option, ignoring frames without `key` or `text`. Verify with driver tests: warning, error, and no-color frames, and that a malformed frame is ignored.

## 4. Manager merge, lifecycle, and fan-out

- [x] 4.1 In `ChatSessionManager`, keep the per-session agent notice map with same-key replacement and `timeout_ms` expiry timers that check the instance is unchanged. Clear the map and its timers on stop, archive, kill, and restart. Verify with manager tests using fake timers: replacement, expiry, an untimed notice persisting, archive and kill clearing, and no leak into another session.
- [x] 4.2 Map each session to its credentials path via `launchFor` on attach (archived included) and on agent start, and check the store. Merge the account notice first, then sort by priority and newest (design D5). Add `notifications` to `getSnapshot` and emit `onNotifications(sessionId, list)` on any change. Verify with tests: snapshot contents, two sessions sharing a credentials path both updating, an unknown profile giving no notice, and an archived chat getting an account notice but no agent notice.
- [x] 4.3 Handle `chat-dismiss-notification` for agent notices (unknown keys are a no-op) and push the new list. Verify with a WebSocket handler test.
- [x] 4.4 Add `publishNotifications` to `ChatConnections`, batched into the existing flush like `publishUsage`. In `src/server/index.ts`, wire `onNotifications` and a 30-minute recheck timer for attached sessions' credentials paths, cleared on shutdown. Verify with `ChatConnections` tests that only subscribed connections receive the push, and that `bun run test` passes.

## 5. Client strip

- [x] 5.1 Store `notifications[sessionId]` in `chatStore` from snapshots and `chat-notifications`. Add client-side closing of account notices, keyed by `${sessionId}:${key}:${text}`, and a dismiss action that sends `chat-dismiss-notification` for agent notices. Verify with store tests: replace semantics, a hidden account notice reappearing when its text changes, and a dismiss sending the message.
- [x] 5.2 Create `NotificationStrip.tsx` and render it under the header next to `UsageBar` in `ChatView.tsx`. Use one line per notice with a severity style, a dim hint, and a close button, and render nothing when the list is empty. Use solid semantic colour tokens, with no `/opacity` utilities. Verify with component tests for the warning and error styles, priority order, the empty state, and close buttons calling the right actions.
- [x] 5.3 Update the `How It Works` section of `CLAUDE.md` with a notifications bullet covering both sources, ephemerality, and closing. Verify that the bullet matches the implemented behavior.

## 6. Integration

- [ ] 6.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass.
- [ ] 6.2 Verify end to end without touching the live kawai instance or running `test:e2e`. Start a dev server on a spare port with `CLAUDE_CONFIG_DIR` pointing to a temp copy of `.credentials.json` whose `refreshTokenExpiresAt` is set 1.4 days ahead. Attach over WebSocket and confirm the snapshot carries "Your login expires in 2 days". Then use the `dev-browser` skill to screenshot the strip in a chat view.
- [ ] 6.3 Run `openspec validate show-cli-notifications-in-chat --strict` and verify it passes.

## Workflow follow-up

- Archive the change after review, which syncs `chat-notifications` into `openspec/specs/`.
