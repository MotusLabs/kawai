# Proposal

## Why

Team mail is durable, but once a message is delivered it disappears from every human surface: the Mailbox panel (`TeamMailboxPanel.tsx`) lists only pending and problem rows (`MailboxStore.listForTeam` excludes `delivered`, `cancelled`, `discarded`, `forwarded`), peer rows in a recipient's transcript name senders by raw session id, and a killed session's name is gone with its `chat_sessions` row. Following a handoff means opening chats one by one. The human also cannot write into the team's mail at all — every message must come from an agent — and retrying an uncertain message rewrites the row in place (`MailboxStore.retry` clears `claimed_by`, `reason`, `pushed_at`), so the evidence of what happened is lost. This is baseline P1 "Named, navigable messages and full thread history" (docs/multi-agent-development-ux.md §4, E06, E11).

Depends on `agent-teams`, `agent-mailbox`, and `team-tasks` (shipped) and on `profile-routing` (implemented: parked/forwarded states and the `team_messages` columns it added). No dependency on other Wave B1 changes; see design.md for the interfaces assumed from `team-waiting-reasons`, `task-assignment`, and the later `team-workspace`.

## What Changes

- **One Messages model.** A team-scoped read API over `team_messages` returns delivered history and pending mail together, newest first and paged, with filters for task, thread, group (role), session, priority, and delivery state (pending, delivered, problems, closed, to/from the human). Task detail embeds the task-filtered subset with the same named rows and thread links. The open view stays current as mail changes and after reconnect.
- **Thread detail.** All messages of a thread in any state, chronological, with reply relations (`in_reply_to`), current recipient or claimant, delivery state, the task revision the envelope carried at delivery (new `task_revision` column written at push), and the message's history.
- **Message history log.** A new append-only `team_message_events` table records every state change of a message — sent, reserved for a spawn, claimed, pushed, delivered, requeued, held for a request, held uncertain, retried, cancelled, discarded, dead-lettered, parked, unparked, released, forwarded — with the actor (system or human) and the facts the change overwrote (previous claimant, recipient, reason). Uncertain retry/discard and cancel history therefore stays in the thread.
- **Named participants.** Senders and recipients render as session names with group (role) badges; ids stay in expandable metadata. A new `team_session_directory` table keeps each team session's last name and group after it is killed, so history shows "Name (gone)" instead of a bare id. Clicking a live or archived participant opens its chat.
- **The human as a mail participant.** The human sends messages from a composer (recipient group or session, optional task, body, priority — normal by default, with urgent semantics explained) and replies in threads. Human mail records the human as sender exactly as team-tasks records the human as creator: a `kind: 'human'` actor with no session id (`from_kind`, nullable `from_session`). The envelope names the human as sender. An agent's `reply` to a human message goes to the human (`to_kind: 'human'`), is settled on send, and raises a toast; agents still cannot start new mail to the human.
- **Messages side panel.** A **Messages** header toggle opens a sibling panel in the chat side slot (with Debug, Mailbox, Tasks), built on a host-agnostic `TeamMessagesView` that the later `team-workspace` change mounts full-page. The Mailbox panel keeps its delivery-operations role (routing, parked hand-off, waiting reasons) and is unchanged by this change. Task detail message rows link to their thread.

**Non-goals** (named follow-ups):
- Full-page Team view, attention queue, keyboard/mobile list-detail navigation → `team-workspace`.
- Delivered vs acknowledged and revision notifications → `task-revision-publication`.
- Waiting reasons on pending rows → `team-waiting-reasons` (rendered here only if present).
- Accountable owner / assignment state on messages → `task-assignment`.
- Agent-initiated mail to the human (`send_message` to `human`), read/unread state for human mail, and full-text search of bodies.
- Retroactive history for messages created before this change (they show their row timestamps only).

## Capabilities

### New Capabilities

- `team-message-history`: the team Messages view and its read API — delivered and pending mail in one paged, filterable list; thread detail with reply relations, recipient, state, and task revision at delivery; the append-only message history; named participants including killed sessions; click-through to chats; live updates and team scoping.

### Modified Capabilities

- `agent-mailbox`: the human can send and reply to team mail; sender context records a human sender; a reply to human mail reaches the human; uncertain retry/discard keeps its history in the thread.

## Impact

- Server: `src/server/team/mailboxStore.ts` (event recording inside every transition, `task_revision`, `from_kind`/`to_kind: 'human'`, one guarded table rebuild making `from_session`/`to_id` nullable), new `messageEvents.ts`, `messageQuery.ts` (filters/paging), `sessionDirectory.ts`; `TeamMailbox.ts` (human send/reply, reply to human), `envelope.ts` (human sender), `dispatcher.ts` (revision at push), `teamPrompt.ts`; new `messageConnections.ts` beside `mailboxConnections.ts`; `ChatSessionManager.ts` (directory upkeep on create/rename so names survive kill), `ChatConnections.ts` (to-human toast push), `taskStore.ts` participants query (skip null senders).
- Shared: `src/shared/team.ts` (`TeamActor`, `MessageEvent`, query/filter types; `TaskActor` becomes an alias), `src/shared/chat.ts` (`ChatPeerMessage.senderKind`, nullable `senderSession`), `src/shared/types.ts` (`team-messages-*`, `team-thread-*`, `team-message-send`/`team-message-send-result` following the task-action request pattern).
- Client: new `TeamMessagesView.tsx`, `TeamMessagesPanel.tsx`, `TeamThreadDetail.tsx`, `TeamMessageComposer.tsx`, `teamMessagesStore.ts`; `ChatView.tsx` (Messages toggle), `ChatMessages.tsx` (human sender label), `TeamTaskDetail.tsx` (open thread link), `App.tsx` (routing pushes, toast).
- Data: additive tables `team_message_events`, `team_session_directory`; additive columns on `team_messages`; one guarded rebuild of `team_messages` to relax two NOT NULL constraints.
- Tests: unit/integration tests per task; Playwright `tests/e2e/chat-team-messages.spec.ts` for E06/E11 (written, not run here).
