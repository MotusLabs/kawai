# Design

## Context

See proposal.md (Why) for the two sources: a login expiry Kawai must compute itself, and the `system`/`notification` frames Kawai currently drops.

What we observed in the CLI (Claude Code 2.1.296):

**Login-expiry rule.** The REPL's `oauth-expiry` banner shows only when all of these hold:
- the API provider is first-party, meaning no `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY`;
- the session authenticates with the stored claude.ai OAuth login, not `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`;
- the stored `claudeAiOauth.refreshTokenExpiresAt` is a number;
- `expiresAt` is not more than 3 days past it;
- `0 < refreshTokenExpiresAt − now ≤ 3 days`.

It renders `Your login expires in ${ceil(ms/day)} day(s)` + ` · run /login to renew`. A second, footer variant fires only at ≤1 day. Both are REPL-only.

**SDK notification frames.** `SDKNotificationMessage` is `{ key, text, priority: low|medium|high|immediate, color?, timeout_ms? }`. Producers seen in the binary:
- `model-effort-cap`, `model-context-window`, `memory-paused`, and `session-auto-memory-off`, sent at stream-json startup;
- `fast-mode-overage-rejected`;
- the model-restricted re-probe;
- `error-compacting-conversation`;
- `stop-hook-block-cap`;
- the engine's generic forward of in-loop notifications.

**Existing plumbing to mirror.**
- Per-profile plan usage (`UsageLimitStore`, `chat-usage`, `UsageBar`): in-memory, carried in the snapshot, additive message.
- Per-session ephemeral `chat-activity`.
- `chatAuth.ts`, which already resolves `CLAUDE_CONFIG_DIR`/`.credentials.json` from an effective environment.
- `ChatSessionManager.launchFor(profileId, projectPath)`, which returns the exact env a session's agent receives.

## Goals / Non-Goals

**Goals:**
- Reproduce the CLI's login-expiry rule exactly, so Kawai warns when, and only when, the CLI would.
- Forward every agent notification frame without a per-key allowlist. New CLI notices then appear without Kawai changes.
- One shared notice shape and one strip for both sources.

**Non-Goals:**
- Persisting notices, adding them to the transcript, or making them affect status.
- Showing an "already expired" notice. The CLI shows none, and turns then fail with an auth error the transcript already shows.
- Reading the macOS Keychain, or inspecting what wrapper executables do to the environment.
- Rendering `system`/`informational` lines. They are transcript-level output, a separate concern.

## Decisions

### D1. Shared contract: `ChatNotification`
`{ key, source: 'account' | 'agent', severity: 'info' | 'warning' | 'error', priority: 'low' | 'medium' | 'high' | 'immediate', text, hint?, receivedAt }`.

- `text` and `hint` stay separate, like the CLI's warning text and dim suffix, so the client can style the hint quietly.
- The agent `color` maps to severity: `warning` → warning, `error` → error, anything else or absent → info.
- The snapshot gains `notifications: ChatNotification[]`. A new additive server message `{ type: 'chat-notifications', sessionId, notifications }` uses replace semantics, so a missed push heals on the next one.
- *Alternative:* reuse the transcript `notice` event. Rejected: notices are sequenced and persisted, and replay would resurrect stale warnings.

### D2. Account notices: a pure check plus a store keyed by credentials path
New SDK-free module `src/server/chat/accountNotices.ts`.

- `loginExpiryNotice(env, now, readFile)` applies the D-context rule and returns a `ChatNotification` or null.
- `credentialsPathFor(env)` returns the credentials path, or null when the env makes the session ineligible. It reuses the config-dir resolution in `chatAuth.ts`, which is extracted and exported, not duplicated.
- An `AccountNoticeStore` caches the latest result per credentials path and notifies subscribers on change. Keying by path rather than profile id handles two cases: profiles that share `~/.claude` share one check, and a project-layered catalog that points a profile elsewhere still gets the right file.
- The manager keeps `sessionId → credentialsPath | null`, computed from `launchFor(record)` when a session is attached or started. If `launchFor` throws (unknown profile), the result is null.
- The hint text is `run /login in a Claude terminal to renew`, because `/login` is terminal-bound and hidden in chat.
- *Alternative:* key by profile id, like usage. Rejected: plan usage follows the host login regardless of env, but login expiry depends on the env's config dir and auth variables.

### D3. When account notices are checked
Checks run in three places:
- on `chat-attach`, including archived chats, since no agent is needed;
- on agent start;
- on a server timer every 30 minutes for credentials paths that have at least one attached session.

Each check is one small synchronous file read, and the store reports changes only when the result changes (null, or a new `text`). The timer lives in `index.ts`, next to the other intervals, and is cleared on shutdown.
- *Alternative:* `fs.watch` on the credentials file. Rejected: the file is rewritten atomically on refresh, watches on replaced files are unreliable, and the day count changes with time even when the file does not.

### D4. Agent notices: driver callback and per-session map
`ChatSessionDriver.handleSystem` handles `subtype === 'notification'` before the fallthrough and calls a new `onNotification(frame)` option.

- The manager keeps `Map<sessionId, Map<key, ChatNotification>>` and replaces entries by key.
- A frame with `timeout_ms` arms a timer that removes that entry only if it is still the same instance (compared by `receivedAt`).
- The whole session map and its timers are cleared when the emitting process ends: from the paths that already tear down a driver (stop, archive, kill, restart), and — because a crashed driver respawns internally without a new driver construction — from an `onProcessEnd` callback the driver fires when it marks itself dead. This matches "until the agent process ends".
- Malformed frames (missing `key` or `text`) are ignored.
- Wire capture already records the frames, so the Debug view needs no change.

### D5. Merge and fan-out
`ChatSessionManager.notificationsOf(sessionId)` returns the account notice followed by agent notices, sorted by priority (immediate > high > medium > low), then newest first. The manager emits `onNotifications(sessionId, list)` whenever either source changes for that session:
- an account change fans out to every session mapped to that credentials path;
- an agent change goes to its own session.

`ChatConnections.publishNotifications` batches per connection into the existing flush, like `publishUsage`. `index.ts` wires the callback.

### D6. Closing
- **Agent notices:** a new client message `{ type: 'chat-dismiss-notification', sessionId, key }`. The server removes the key and pushes the new list. Unknown keys are a no-op.
- **Account notices:** closed client-side only. `chatStore` keeps an in-memory `Set` of `${sessionId}:${key}:${text}`. A new day count changes the text and shows the notice again, and a reload clears the set. This keeps one user's tab from hiding an account-wide warning for others, and leaves no server state to clean up.

### D7. Client strip
`src/client/components/chat/NotificationStrip.tsx` renders under the header, beside `UsageBar` in `ChatView.tsx`.
- One line per visible notice: a `⚠` for warning or error, the text, the dim `· hint`, and a close button.
- Severity colours use existing semantic Tailwind tokens with solid colours, not `/opacity` utilities, which are dead CSS in this project.
- The strip returns null when the list is empty. `chatStore` adds `notifications[sessionId]` from the snapshot and from `chat-notifications`.

## Risks / Trade-offs

- [The CLI changes its credentials schema or expiry rule] → Keep the rule in one tested module, with a comment citing the observed CLI version. Unknown shapes produce no notice, never an error.
- [Wrapper-executable profiles may change config dir or auth inside the wrapper] → Kawai checks the env it passes, so the notice can be wrong for such wrappers. Documented in the proposal's Impact. Wrappers usually route to gateways, where `ANTHROPIC_AUTH_TOKEN` suppresses the check.
- [The CLI starts sending a noisy notification] → Every notice can be closed, and same-key replacement prevents piling up. If it becomes a problem, a key denylist can be added without changing the spec.
- [A 30-minute timer means a renewal shows up late] → Attach and agent start also check, and the rule only matters in a 3-day window.

## Migration Plan

Additive only: a new snapshot field, new server and client messages, and no schema change. Rollback is reverting the change. Older clients ignore the new field and message.
