# Tasks

## 1. Groups and team identity

- [x] 1.1 Add an SDK-free group-file parser in `src/server/team/groupFile.ts` (optional `---` frontmatter of flat `key: value` scalars, markdown body as role prompt; `label` defaulting to the id, one-line `description`, positive-integer `hopLimit`), and verify unit tests cover a full file, a body-only file, the label default, and malformed frontmatter / invalid `hopLimit` returning an error instead of a group
- [x] 1.2 Add `src/server/team/groupCatalog.ts` loading `.kawai/groups/*.md` from the repository's main working tree layered over `~/.kawai/groups/` (home injectable for tests), validating ids against `^[a-z0-9][a-z0-9-]*$` and reporting each skipped file with its path while other groups stay available, and verify tests cover project discovery, user-level fallback, project-over-user override, an invalid id (`Team Lead.md`), and a malformed file beside a valid one
- [x] 1.3 Add `src/server/team/teamIdentity.ts` resolving a project path to `{ teamId, groupsRoot }` with `resolveGitDirs` (team = canonical common git dir, groups root = main working tree; non-repository directories use their own realpath), cached per directory, and verify tests with a temporary repository plus a linked worktree resolve one team, two repositories resolve two teams, and a plain directory resolves a team of its own

## 2. Group membership of chat sessions

- [x] 2.1 Add a nullable `group_id` column to `chat_sessions` (inline migration in `initDatabase`, `groupId` on `ChatSessionRecord`, insert / update `fieldMap` / `mapChatRow`), and verify db tests round-trip a group, keep it through archive and restore, and leave pre-existing rows with no group
- [x] 2.2 Carry `groupId` on the shared `Session` and as optional `groupId` on `session-create`; validate it against the team's catalog in `createAvailableSession` (unknown group refused with an error, absent = no group) and never change it after creation, and verify manager tests cover create-with-group, create-without-group, an unknown group, and the group surviving restart
- [x] 2.3 Expose the team's groups and catalog errors for a project path over a `/api/chat/groups` route, and verify route tests return layered groups and report a malformed file
- [x] 2.4 Add a group picker (default "No group") to the chat block of `NewSessionModal.tsx` fed by that route, and a group badge beside the Chat label in `SessionRow.tsx` (marked missing when the stored id is no longer defined; `SESSION_FIELD_EQUALS` updated), and verify component tests cover choosing a group, creating without one, and the missing-group badge

## 3. Role and mailbox prompt

- [x] 3.1 Add a pure `src/server/team/teamPrompt.ts` building the appended system prompt: the role body (members only) and a mailbox note naming the member's group, every team group with its description, how mail arrives (peer turns, envelope fields, message id), and how to send, and verify tests pin a member's prompt and a no-group session's note-only prompt
- [x] 3.2 Pass that prompt as `systemPrompt: { type: 'preset', preset: 'claude_code', append }` from the driver at each spawn (read from the catalog at spawn time only), and verify driver tests show the appended prompt in spawn options and that editing the group file changes only the next spawn's prompt

## 4. Mailbox store

- [x] 4.1 Add the `team_messages` table (design D5 columns plus `pushed_at`, states `queued` / `claimed` / `pushed` / `delivered` / `dead` / `uncertain` / `cancelled` / `awaiting-request`) and a `src/server/team/mailboxStore.ts` API (enqueue, atomic claim by `UPDATE … WHERE state='queued'`, mark pushed / delivered, requeue, dead-letter, hold uncertain, cancel, retry, discard, list per team, eligible-for-recipient query), and verify store tests cover a lost claim race (exactly one winner), persistence across reopening the database, and each state transition
- [x] 4.2 Count hops per thread and dead-letter a send that would exceed the sender group's `hopLimit` (else 20), with a retry that resets the thread's hop count, and verify tests stop a ping-pong past the limit and requeue it on retry

## 5. Mailbox tools

- [x] 5.1 Add `zod` as a direct dependency and build a per-driver in-process `kawai-team` MCP server (`createSdkMcpServer` + `tool()`) with `send_message`, `reply`, `schedule_message`, and `list_groups`, whose handlers close over the sending session (sender, group, and `origin_path` from the session record, never from input) and return a message id immediately, and verify handler tests cover send to a group, send to a member, an unknown group, a recipient in another team, and a forged sender/origin in input being ignored
- [x] 5.2 Register the server in the driver's spawn options and auto-allow its tools (no approval card under either policy), and verify driver tests show `mcpServers` and the allowed tool names in spawn options and that a mailbox tool call creates no approval request

## 6. Delivery

- [x] 6.1 Add the `peer_message` ChatEvent (sender session, sender group, priority, origin path, tags, thread id, message id, body) and a fixed envelope format with parse/format helpers in `src/server/team/envelope.ts`; add `deliver(envelope)` to the driver that pushes a turn with `origin: { kind: 'peer', … }` and emits `peer_message` (display only), and make transcript replay turn envelope rows back into `peer_message`, and verify tests cover format/parse round-trip, the live event, replay reconstruction, and the possible-duplicate notice variant
- [ ] 6.2 Add `src/server/team/dispatcher.ts` fed by manager status changes: idle = `waiting`, no pending request, no live worker, not archived, project directory present; on idle claim the next eligible message (urgent first, then direct before group, then oldest) and deliver it, with group mail going to the longest-idle member and the idleness re-checked inside the claim, and verify tests cover a busy recipient keeping mail queued, prompt delivery to an idle one, both ordering scenarios, two members idling together receiving one message once, and an archived member never claiming
- [ ] 6.3 Sequence urgent direct mail per design D8 (hold as `awaiting-request` while a card is pending, re-evaluate on `request_resolved`; otherwise claim, interrupt, wait for `turn_interrupted`, push) while urgent group mail never interrupts, and verify tests cover interrupt-then-deliver, a pending card staying open until answered, and urgent group mail waiting for the next idle member
- [ ] 6.4 Deliver scheduled messages when `deliver_at` passes (one re-armed timer for the earliest due row, restored at startup), and verify tests cover a reminder to self arriving at its due time once idle and a due time surviving a store reopen
- [ ] 6.5 Route replies into the original thread to the original sender: restore an archived sender then deliver once idle; send a killed sender's reply to its stored group with the full thread attached; dead-letter it when the killed sender had no group; dead-letter queued direct mail when its recipient is killed, and verify tests cover each of those four paths
- [ ] 6.6 Document groups, teams, and mailbox delivery in the How It Works section of `CLAUDE.md`, and verify the bullets name the group file location, the team scope, and the delivery rules

## 7. Crash-safe delivery

- [ ] 7.1 Write `pushed_at` immediately before each push and watch the recipient's transcript (reusing the title watcher's re-arming file watch) for a well-formed row carrying the message id, setting `delivered_at` on first sighting, and verify tests mark a message delivered only once the row appears and never on the push or `peer_message` event alone
- [ ] 7.2 Reconcile at startup: claimed-not-pushed rows requeue; pushed-not-delivered rows become delivered when the row is found, requeue when the transcript ends cleanly without it, and are held `uncertain` when the transcript is missing, unreadable, or ends in a torn row, and verify one test per spec scenario (crash after delivery, after claim, after push before consumption, torn row, unreadable transcript)
- [ ] 7.3 Let a human retry an uncertain message only to the same recipient with the possible-duplicate notice, or discard it explicitly, and verify tests show retry targets the original recipient with the notice and no other member can claim it

## 8. Visibility

- [ ] 8.1 Render `peer_message` as a distinct transcript row (sender, group, priority, origin path, tags) in `ChatMessages.tsx`, and verify component tests show the row apart from user messages and restored from a reconnect snapshot
- [ ] 8.2 Add team-mailbox client/server messages (open, close, cancel, retry, discard; a mailbox snapshot push on change) handled in `ChatConnections` or a sibling, and verify connection tests cover snapshot on open, a push after enqueue, and each action
- [ ] 8.3 Add a team mailbox view listing queued, scheduled, dead-lettered, and uncertain messages with sender, recipient, priority, and age, with cancel, retry, and discard actions, and verify component tests cover each list and action
- [ ] 8.4 Notify the human when a message is dead-lettered by the hop limit (a new additive server message shown as a toast via `toastManager`), and verify a test shows the toast for a hop-limit dead letter

## 9. Integration

- [ ] 9.1 Add a headless integration test running two fixture chat sessions in one temporary repository (a `devs` member and a team lead) where the lead's `send_message` handler queues mail that the dev receives as a new turn once idle and whose reply returns to the lead, and verify the test passes
- [ ] 9.2 Walk the group picker, navigator badge, peer-message row, and mailbox view in the browser against the fixture, and verify each renders as specified
- [ ] 9.3 Run `bun run lint && bun run typecheck && bun run test` and verify the full suite is green

## Workflow follow-up

- Archive the change after review; sync the new `agent-teams` and `agent-mailbox` capabilities into main specs.
- Continue with `team-tasks`.
