# Tasks

## 1. Agent actors in message history

- [ ] 1.1 Add `'agent'` to `MessageEventActor` and `actorSession: string | null` to `MessageEvent` in `src/shared/team.ts`. Add the nullable `actor_session` column to `team_message_events`, added if missing (D3). Update `mapEvent`. Verify with a `teamMessageEvents.test.ts` case that an existing database gains the column and old rows read `actorSession: null`.
- [ ] 1.2 Change the store's internal actor parameter to an object (`system` / `human` / `agent` with session) and write both columns in `recordEvent`. Make `MailboxConnections` pass `{ kind: 'human' }` for cancel, retry, and discard. Verify with a store test that a human cancel logs `actor: 'human'` and an agent cancel logs `agent` plus its session.
- [ ] 1.3 Render agent actors in the Messages thread history with the resolved participant name (live or `(gone)`); unknown actors render as `system`. Verify with a client component test.

## 2. Parked cancel in the store

- [ ] 2.1 Widen `MailboxStore.cancel(id, actor, reason?)` to accept `parked`. In one transaction, clear `parked_until`/`resume_message_id` and cancel the still-queued resume message with reason "parked work <id> cancelled" (D2). Leave a claimed or delivered resume message unchanged. Verify with store tests: queued resume cancelled; delivered resume untouched; a lost race returns `false`; both events recorded.
- [ ] 2.2 Agent cancel and discard set the row's `reason` to `cancelled by <session>: <text>` / `discarded by <session>: <text>`, with the text cut to 300 characters (D4). Human actions keep no reason. Verify with a store test, and with an assignment test that a cancelled instruction reads `failed` with that reason.
- [ ] 2.3 Make `LimitOutcomes` drop the active work and digest when a final limit resolves work that is no longer `parked`/`delivered`, instead of re-parking or forwarding it. Verify with a `limitOutcomes` test that cancels parked work during its resume turn, ends the turn on a limit, and asserts no new park, forward, or resume mail. Add a sibling case where the turn succeeds and the cancelled row stays cancelled.
- [ ] 2.4 Verify with a `ChatSessionManager`/session-mailbox test that cancelling a holder's only parked message clears `Session.parked`, leaves an archived holder archived, and makes it eligible for group mail again when live.

## 3. Group setting

- [ ] 3.1 Parse `canManageMailbox: true|false` in `groupFile.ts` (default `false`; an invalid value adds a warning and stays `false`, D7). Expose it on `GroupDefinition`. Verify with `groupFile` tests for true, false, absent, and invalid, and check that the groups route returns the warning.
- [ ] 3.2 Document `canManageMailbox` in the group settings list of `docs/routing/README.md` and in the CLAUDE.md group-settings bullet. Verify by reading the rendered list.

## 4. Management service and tools

- [ ] 4.1 Create `src/server/team/mailboxManagement.ts` with `cancel`, `discard`, and `list` (D1, D6). It resolves the caller's team and current group file per call; refuses other-team ids as not found; checks sender-or-manager rights (parked cancel and discard require management); checks states with refusals naming the current state; requires a non-empty reason; and maps a store `false` to a "state changed" error. Verify with `mailboxManagement.test.ts` covering every scenario in `specs/team-mailbox-management/spec.md`: own queued, scheduled, and awaiting-request cancel; claimed and spawning refused; non-sender non-manager refused; manager cancels other mail and parked work; other team not found; discard of dead and uncertain by a manager only; empty reason refused.
- [ ] 4.2 Implement `list` scoping and projection. Non-managers see own-sent, direct-to-self, and claimed-or-held rows; managers see the whole team. Support filters on state, to, from, and task. Include the `waiting` blocker from the dispatcher's in-memory reasons, cut bodies to 300 characters, and cap at 100 rows with an omitted count. Verify with service tests for both scopes, each filter, the cap, and no cross-team rows.
- [ ] 4.3 Append the task journal note as the acting agent through `TaskService.note` when the message has a task (D5). Skip a cascaded resume message. Log journal failures without undoing the mailbox action. Verify with a service test reading the journal, plus a failure-path test.
- [ ] 4.4 Register `cancel_message`, `discard_message`, and `list_mailbox` in `mailboxTools.ts` with zod schemas and descriptions, wired through the session's dispatcher and publish path so changes notify the dispatcher and mailbox subscribers. Add them to `TEAM_ALLOWED_TOOLS`. Verify with a tools test that the handlers bind the caller's session (forged ids are ignored) and that the allowed-tool list includes the three names.
- [ ] 4.5 Extend `mailboxNote` in `teamPrompt.ts`: list and withdraw for everyone; for `canManageMailbox` groups, cancel-any including parked work, discard, the retry/hand-off-stay-human rule, and the "list and cancel before replacing a stuck agent" advice (D8). Verify with `teamPrompt` snapshot tests for a manager and a non-manager group.
- [ ] 4.6 Update the CLAUDE.md How It Works bullets for the `kawai-team` tools and the event-log actor vocabulary. Verify the bullets name the three tools and the `agent` actor.

## 5. Human Mailbox panel

- [ ] 5.1 Show **Cancel** on parked rows beside Hand off in `TeamMailboxPanel.tsx`, sending `team-mailbox-cancel`, and confirm `MailboxConnections` routes parked cancels through the widened store path. Verify with a panel component test and a connection test (parked cancel succeeds; a parked row unparked meanwhile returns the "no longer available" error).
- [ ] 5.2 Show each row's short id (first 8 characters, monospace) with the full id in `title` and a copy button. Verify with a component test that the row for a given id shows its prefix and that copying yields the full id.
- [ ] 5.3 Verify the whole panel with the `dev-browser` skill on a fixture team: a parked row shows Cancel and an id, Cancel removes it from Parked, and the resume row disappears from Scheduled. Take a screenshot.

## 6. Repository configuration and integration

- [ ] 6.1 Set `canManageMailbox: true` in `.kawai/groups/lead.md`. Verify that the groups route shows the flag for `lead` with no warnings.
- [ ] 6.2 Integration check: replay the 2026-10-14 incident in an integration test. Park work on a dev and queue a stale follow-up to its group for the same worktree. The lead lists, cancels the follow-up and the parked work, then the dev is archived. Assert that no member is spawned and no resume is delivered. Run `bun run lint && bun run typecheck && bun run test` and verify it passes.
- [ ] 6.3 Run `openspec validate team-mailbox-management --strict` and verify it passes.

## Workflow follow-up

- If `team-member-release` merges first, rebase onto it and resolve the overlaps in `groupFile.ts`, `mailboxTools.ts`, and `teamPrompt.ts`.
- Archive the change after review and merge, then confirm the synced `agent-mailbox` and new `team-mailbox-management` specs.
