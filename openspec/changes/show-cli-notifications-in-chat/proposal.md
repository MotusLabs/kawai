# Proposal

## Why

The interactive Claude CLI warns about things the user must act on, for example `⚠ Your login expires in 2 days · run /login to renew`. Kawai chat sessions show none of these warnings. A login can expire unnoticed until chats stop authenticating, and the agent's own runtime warnings (context window capped, fast-mode credits exhausted, model restricted, compaction failed) are dropped. Kawai chat should show the same warnings the CLI would.

Two facts found while inspecting Claude Code 2.1.296 shape this change:

- **The login-expiry warning never reaches the SDK.** The CLI draws it only as a terminal (REPL) startup banner. It computes the warning from `refreshTokenExpiresAt` in the config dir's `.credentials.json`: it appears for first-party OAuth logins in the last 3 days, as `ceil(days)` left. Kawai must compute it itself.
- **Other CLI notices do reach the SDK, but Kawai ignores them.** The CLI sends `system`/`notification` frames (`key`, `text`, `priority`, `color`, `timeout_ms`). Today `ChatSessionDriver.handleSystem` drops them as "informational".

## What Changes

- New **chat notification strip** under the chat header, next to the usage bar. It shows active notifications, styled by severity, each closable for the current view.
- **Account notices per profile:** the server checks each Claude profile's stored CLI login using that profile's effective environment, mirroring the CLI's rule. While the refresh token expires within 3 days, every chat session on that profile shows `Your login expires in N day(s)`, with a hint to renew by running `/login` in a Claude terminal. The terminal is needed because `/login` is terminal-bound and hidden in chat. The check reruns when an agent starts, when a client attaches, and on a slow timer. The notice clears itself once the login is renewed.
- **Agent notices per session:** `system`/`notification` frames from the agent become session notifications. A new one with the same `key` replaces the old one. A notice expires after the CLI's `timeout_ms` when one is given. Otherwise it stays until the user closes it or the agent process ends.
- Notifications are ephemeral, like activity and plan usage. The chat snapshot carries them, and an additive `chat-notifications` message pushes changes. They are never persisted, sequenced, or replayed, and never part of the transcript or the session-list status.
- No breaking changes. Older clients ignore the new snapshot field and message.

## Capabilities

### New Capabilities
- `chat-notifications`: CLI-style notices in chat sessions: account notices computed from a profile's stored login (login expiry), agent-emitted notices from the SDK notification channel, how they reach clients, and how the chat view shows and closes them.

### Modified Capabilities
<!-- None: the transcript, usage bar, and status requirements are unchanged; notifications are a separate surface. -->

## Impact

- **Server:**
  - New SDK-free module `src/server/chat/accountNotices.ts` that reads the login expiry from the profile's environment and credentials file.
  - New notification store keyed by profile and by session.
  - `ChatSessionDriver.handleSystem` forwards `notification` frames through a new driver callback.
  - `ChatSessionManager` adds `notifications` to the snapshot and wires up the store.
  - `ChatConnections` fans out `chat-notifications`, alongside the existing `chat-usage`.
  - The check timer is wired in `src/server/index.ts`.
- **Shared contracts:** `ChatNotification` in `src/shared/chat.ts`; `chat-snapshot.notifications` and the `chat-notifications` server message in `src/shared/types.ts`.
- **Client:** new `NotificationStrip.tsx` under the chat header in `ChatView.tsx`; `chatStore` state for notifications and per-view closing.
- **Out of reach:**
  - Other terminal-only startup banners (model deprecation, MCP needs auth, announcements, and so on). Their data is not exposed to SDK hosts.
  - macOS Keychain-stored logins. There is no credentials file to read, so no expiry notice appears.
  - Wrapper executables that switch the config dir themselves.
