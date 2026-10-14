# Tasks

## 1. Group settings

- [ ] 1.1 Parse `releaseOnTaskClose` (default true), `worktreeScoped` (default true), and `canReleaseMembers` (default true; opt out with `false`) in `src/server/team/groupFile.ts` as strict `true|false`, rejecting other values like `canCreateTasks`; extend `GroupDefinition` and update the header comment.
- [ ] 1.2 Cover defaults, explicit values, and invalid values in `teamGroupFile.test.ts`.

## 2. Worktree scoping opt-out

- [ ] 2.1 Make `targetWorktree` in `sessionMailbox.ts` return null for group mail whose receiving group's current definition sets `worktreeScoped: false`, resolving definitions into a per-cycle map in the order D5 names (clear cache → await definitions of groups with waiting mail or pending releases → `evaluate()` → route; widen `beginCycle` in `dispatcher.ts` to `() => void | Promise<void>` and await it before `passDiagnoses.clear()`, keeping `outcomes.processNotes()` in `sessionMailbox.ts`'s hook; test that a release and a D8 dead letter in the hook finish before routing and that `afterPass` does not report the dead-lettered row as waiting); a missing definition stays scoped (returns the task's worktree); keep direct mail and scoped groups unchanged.
- [ ] 2.2 Tests in `sessionMailbox.test.ts`/`teamStaffing.test.ts`: task mail to an unscoped group reaches an idle member in the main checkout; an unscoped group never spawns for it; a killed-sender reply falling back to an unscoped group is delivered with its thread; `devs` without the key keeps worktree routing and spawning.

## 3. System journal author

- [ ] 3.1 Add `JournalAuthor = TaskActor | { kind: 'system'; sessionId: null }` in `src/shared/teamTasks.ts` for journal entries only; map `author_kind = 'system'` in `taskStore.ts`; skip system authors when deriving participants.
- [x] 3.2 Check how the pre-change actor mapper reads an unknown `author_kind` and record the rollback consequence in design.md's Migration Plan. (Done in review: `actor()` coerces it to the human without throwing; rollback deletes `system` rows first.)
- [ ] 3.3 Render system entries as "Kawai" in `TeamTaskDetail.tsx` (and wherever the journal author label is formatted, `teamTaskLabels.ts`).
- [ ] 3.4 Tests: store round-trip and participants in `teamTaskStore.test.ts`; label rendering in the task detail tests.

## 4. Pending releases on task close

- [ ] 4.1 Create `src/server/team/memberRelease.ts` with the `team_member_releases` table (D1) and methods to mark a task's live spawned members (honoring the group opt-out), cancel by task, and cancel by session.
- [ ] 4.2 In `TaskService.setStatus`, mark pending releases in the same transaction as a transition into `done`/`cancelled` (any actor) and cancel them on a transition out; record who closed the task.
- [ ] 4.3 Cancel a session's pending release when it is archived or killed by any path and when the human restores it (`ChatSessionManager.archive`/`kill`/`restore`).
- [ ] 4.4 Spawns in flight (D1): in the close transaction dead-letter the task's `spawning` mail as `task-closed`; when `ChatSessionManager` creates a spawned session whose task is already `done`/`cancelled`, write its pending-release row (group opt-out honored).
- [ ] 4.5 Tests in a new `memberRelease.test.ts`: only spawned members of the closed task are marked; human-created and other-task members are not; opted-out groups are not; reopen and restore cancel; rows survive a store reopen (restart); a spawn completing after its task closed gets no first turn, is marked, and is released when idle, freeing its worktree slot.

- [ ] 4.6 Closed-task mail (D8): in the close transaction dead-letter the task's `queued`/`awaiting-request`/`spawning` group mail to worktree-scoped groups as `task-closed`; in the dispatcher, dead-letter such mail for a `done`/`cancelled` task before claim or spawn. Tests: a queued instruction is dead-lettered and nothing spawns; direct mail and mail to an unscoped group are still delivered; reopening does not revive the dead letter.

## 5. Release execution

- [ ] 5.1 Implement readiness (D3), the one definition every release path uses, from the dispatcher's recipient view, worker roster, and mailbox facts: idle, no pending request, no live background worker (`getWorkers`), no claims, no parked mail, no due queued direct mail; unavailable members count as ready. Export it for `release_member` and `task-results-handoffs`. Add a `MailboxStore` query for due queued direct mail to a session if none exists. Expose live workers from `ChatSessionManager` (its `getWorkers` is private: add an accessor or `hasLiveWorkers`), and wire a new `onWorkers` subscription in `bootstrap.ts` beside `publishWorkers` that notifies the dispatcher when a pending member's last live worker ends.
- [ ] 5.2 Run `evaluate()` from the dispatcher's `beginCycle` (D2): archive ready members through an injected `archive(sessionId)`, re-check the group opt-out from the current file, append the system journal entry, delete the row; notify the dispatcher when a task closes.
- [ ] 5.3 Wire `MemberRelease` into `SessionMailbox` and `ChatSessionManager` (archive callback, task-change subscription, startup evaluation after restore).
- [ ] 5.4 Tests: a busy member is released after its turn ends; a pending approval holds it; a live background worker holds it until the worker ends; a closing direct message is delivered before release; parked work holds it; a release lets waiting group mail spawn in the same or next pass; pending rows are released after a restart; the journal entry names the session and reason.

## 6. `release_member` tool

- [ ] 6.1 Add `release_member` (`session_id`, optional `reason`) to the `kawai-team` server and `TEAM_ALLOWED_TOOLS`; gate on the caller group's current `canReleaseMembers` (permitted by default; a group opts out with `false`); refuse self, human-created, other-team, archived/unknown, and not-ready targets (busy, awaiting a request, live background worker, holds mail) with specific messages (D6); archive and journal on success.
- [ ] 6.2 Describe the tool in `teamPrompt.ts` only for permitted groups, stating that it archives, never kills, and is refused for busy members.
- [ ] 6.3 Tests in `teamMailboxTools.test.ts` and `teamPrompt.test.ts`: every refusal reason, a successful release with its journal entry, prompt text present only for permitted groups.

## 7. Docs and verification

- [ ] 7.1 Update CLAUDE.md How It Works (worktree staffing, team tasks, group settings) and `docs/routing/README.md`'s group settings for the three keys, release on task close, and `release_member`.
- [ ] 7.2 Run `bun run lint && bun run typecheck && bun run test`.
- [ ] 7.3 Verify headlessly over the chat WebSocket against a scratch data directory: close a task with an idle spawned member and see it archived with a journal entry; queue a second task while the group is at `max` and see it spawn after the release.
