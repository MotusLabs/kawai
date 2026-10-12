# Tasks

## 1. Append-only message history

- [ ] 1.1 Add the `team_message_events` table (message id, team, per-message sequence, timestamp, event kind, actor kind, previous state/claimant/recipient/reason where the transition overwrote them) and shared event types; verify migration tests create it beside existing `team_messages` without touching message rows.
- [ ] 1.2 Record an event inside every `MailboxStore` transition — enqueue (sent or dead-lettered), reserve-for-spawn, claim, hold-for-request, push, deliver, requeue, hold-uncertain, retry, cancel, discard, dead-letter, park, unpark, release, forward — with the human as actor for user actions and the system otherwise; verify tests assert one event per transition, ordered sequences, and that retry/requeue/release events retain the claimant and reason the row update clears.
- [ ] 1.3 Expose history queries (events for one message, events within a thread) and verify they return durable rows after closing and reopening the database.
- [ ] 1.4 Document the event log in the How It Works mail paragraphs; verify each documented event kind matches a recorded transition.

## 2. Named participants, including killed sessions

- [ ] 2.1 Add the `team_session_directory` table keyed by team and session id (last known name and group) and upsert it from session creation and rename paths; verify tests cover create, generated and manual renames, repeated upserts, and no writes on kill or archive.
- [ ] 2.2 Add a resolver that labels a participant from live sessions first and the directory second, rendering `Name (gone)` with the role badge and exposing the id as metadata; verify tests cover live, archived, killed-with-directory-entry, and never-seen sessions, and that archived and killed rows never resurrect a session.
- [ ] 2.3 Keep the participants derivation correct for human senders: filter null senders in the task participants query and any other query that assumed `from_session` was present; verify tests show a human sender never becomes a participant id.
- [ ] 2.4 Extend the peer-message row to label senders through the resolver (role badge, expandable id, human label for human senders); verify component tests cover an agent sender, a human sender, and a killed sender keeping its recorded name.

## 3. The human as sender and recipient

- [ ] 3.1 Add `from_kind` and nullable `from_session`, extend `to_kind` with `human` and nullable `to_id`, widen `TeamMessage` and `mapRow` to match (`to_kind: 'human'`, null-safe id mapping — never stringified nulls), and record the task revision a delivery carried; implement the guarded one-time `team_messages` rebuild that relaxes the two NOT NULL constraints and creates all five indexes on the copy itself (`team_messages_queue`, `_thread`, `_recipient`, `_claimant`, and `_task`, whose DDL-block statements have already run by then); verify migration tests round-trip existing rows, run the rebuild exactly once, leave fresh databases untouched, and assert the mapped shape of a human row — not only that rows survive.
- [ ] 3.2 Extend the shared message and peer-envelope types with the actor kind (aliasing `TaskActor`) and a nullable sender session, treating a missing sender kind as a session for compatibility; verify format/parse tests cover a human sender, an agent sender, and previously recorded envelopes.
- [ ] 3.3 Add human send and reply to the mail service with the team's group catalog and task validation (unknown group/session, other-team session, invalid task refused with nothing queued); verify service tests cover both recipient kinds, task inheritance on replies, urgent flags, and that sender identity is bound to the human, never an argument.
- [ ] 3.4 Settle human-directed mail on send — the agent reply to a human-sent message is recorded delivered to the human with no claim or push — and notify connected clients through the existing notice path; refuse agents starting new mail to the human from `send_message` and `schedule_message`; verify tests cover the reply path, the toast push, the refusal, and that human-directed rows never reach the dispatcher.
- [ ] 3.5 Update the agent system-prompt mailbox note: replies to human mail reach the human, new mail to the human is refused; verify prompt tests cover the note for a group member and a session without a group.

## 4. One Messages read model

- [ ] 4.1 Add a query layer over `team_messages` returning delivered and pending mail together — newest first, paged over `created_at, rowid` — with filters for task, thread, group, session, priority, delivery state, and human involvement, plus one thread's messages with their events; verify tests cover each filter, filter combinations, paging boundaries, and team scoping (another team's rows never returned).
- [ ] 4.2 Record the task revision at push time beside the delivery-time task context and surface it on thread rows; verify tests show a later amendment does not rewrite the recorded revision and taskless messages record none.
- [ ] 4.3 Subscribe the query layer to store changes and publish snapshots and pushes per team; verify tests cover change notification for send, delivery, retry, and cancel, and that reconnect receives an authoritative snapshot of the current filters.

## 5. Messages wire protocol and client views

- [ ] 5.1 Add `team-messages-open/close`, `team-messages-snapshot`, `team-messages` push, `team-thread-open` and its detail reply, and `team-message-send`/`team-message-send-result` carrying a client request id; verify connection tests cover open/change/close/disconnect, cross-team refusal, send results, and that request ids never persist.
- [ ] 5.2 Add the messages store and a host-agnostic Messages view: filterable paged list with delivery-state and priority badges, thread detail with reply relations, current recipient, per-message history, and the task revision carried at delivery; verify component tests cover filtering, paging, thread order, event display, and reconnect restoration.
- [ ] 5.3 Add the composer (recipient picker of the team's groups and sessions, optional task, body, priority defaulting to normal with the urgent-interrupt explanation inline) with pending state and inline errors; verify component tests cover send, reply-in-thread with task inheritance, the explanation text, refusal rendering, and disabled state while disconnected.
- [ ] 5.4 Mount the view behind a Messages header toggle in the chat side slot (one of Debug/Mailbox/Tasks/Messages at a time, Mailbox panel unchanged) and embed the task-filtered subset in task detail with named rows and thread links; verify component tests cover toggle exclusivity, task-detail embedding, and that the mailbox panel's operations are untouched.
- [ ] 5.5 Document the Messages view, thread history, named participants, and the human composer (including urgent semantics and possible-duplicate retries) in the How It Works documentation; verify documented behavior matches the rendered components.

## 6. Integration

- [ ] 6.1 Add a headless fixture integration in one temporary repository with a linked worktree: task-linked mail and replies through different sessions build a thread; a kill leaves the sender named; an uncertain hold and retry keeps both events; a human send and an agent reply back reach their targets; verify the test passes with `cleanGitEnv()` for git commands.
- [ ] 6.2 Walk E06 (named senders, chronological thread order, task filtering, delivered history, sender/participant navigation, reload with one sender killed) and the E11 slice (uncertain retry to the same recipient with a possible-duplicate explanation, no reassignment, retained retry/discard history, restart survival) against the fixture using repository Playwright; verify DOM state and screenshots.
- [ ] 6.3 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate team-message-threads --strict`; verify the full suite is green.

## Workflow follow-up

- Keep the boundary against the sibling Wave B1 changes: waiting reasons, assignment state, and the full-page Team view are rendered here only if their changes land them.
- After implementation, review and archive `team-message-threads`, syncing its capabilities into main specs.
