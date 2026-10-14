# Proposal

## Why

A spawned member is never released. When its task is done, it sits idle in its worktree, still counted as a live member against the group's `max`, its profile cap, the team's `maxSpawnedSessions`, and its worktree's one-spawned-writer slot. A team that runs one wave after another stalls on this: in the kawai team's own Wave B1 run, four finished proposal devs filled `devs` (`{ glm: 3, mimo: 1 }`), and both implementation tasks sat queued with no dev spawned until the human archived the old devs by hand. Only the human can archive, so a lead agent cannot clear the way itself, and nothing tells it why the work is stuck.

Separately, worktree scoping applies to every group. Task mail sent to a group whose members never live in task worktrees — a lead or a reviewer working in the main checkout — can never be delivered and never spawns anyone; it waits silently forever. A dev's report to the `lead` group with its `task_id`, and a reply that falls back to the lead group after the lead was killed, are both stuck this way today (the queued review verdict `9465242b` in the same run is one such message).

This is the first step of the UX doc's "Worktree release and reviewer staffing" (docs/multi-agent-development-ux.md §6): a safe release primitive that archives, never kills.

## What Changes

- **Release on task close.** When a task becomes `done` or `cancelled`, its live spawned members — sessions marked spawned for that task — are released: archived once they are idle, have no pending approval or question, have no live background worker, hold no claimed or parked mail, and have no due direct mail waiting. Release is recorded durably at close time, so it survives a restart and still happens once the member settles. Reopening the task before then cancels the pending release. Human-created sessions are never released. Archive is the existing reversible archive; Restore brings the member back and it is not released again for the same close.
- **Release is recorded.** Each release appends a journal entry to the task, authored by kawai (a new `system` journal author), naming the session and why it was released. The freed capacity is re-evaluated at once, so waiting mail can spawn.
- **Group opt-out.** A group sets `releaseOnTaskClose: false` to keep its spawned members after their tasks close (default `true`).
- **Groups outside worktrees.** A group whose file sets `worktreeScoped: false` takes task mail on any idle member regardless of the task's worktree, and is never staffed by worktree spawning. The default stays `true` (today's behavior), so `devs` keeps worktree routing and spawning; a `lead` or `reviewers` group sets `false` so task mail and killed-sender reply fallbacks reach the member in the main checkout.
- **Agent release tool (opt-in).** A new `kawai-team` tool, `release_member`, lets members of groups whose file sets `canReleaseMembers: true` release one spawned member of their team immediately. It archives only; it is refused, with the reason, for the caller itself, human-created sessions, sessions of another team, archived sessions, and members that are busy, awaiting an approval or answer, running a background worker, or holding mail. A release is journaled on the released member's task. Agents still cannot kill or restore sessions.

Non-goals:
- Killing sessions, removing worktrees, or deleting branches.
- The human-facing **Release worktree and hand off** action and its review dispatch (UX doc §6, E07/E08) — later team-workspace work can build it on this release primitive.
- Reviewer staffing policies and read-only enforcement.
- Changing reply routing for archived senders (a reply still restores its archived sender).
- Retroactive release: tasks closed before this change ships leave their members as they are.

## Capabilities

### New Capabilities

- `team-member-release`: when and how spawned team members are released (archived) — on task close and by an opted-in agent tool — the readiness conditions, durability across restart, cancellation on reopen, journaling, and the group settings `releaseOnTaskClose` and `canReleaseMembers`.

### Modified Capabilities

- `team-worktree-staffing`: worktree-scoped delivery and spawning apply only to groups that are worktree-scoped; `worktreeScoped: false` groups take task mail on any idle member and never spawn for it; released members free their capacity immediately.
- `team-tasks`: journal entries may be authored by kawai itself (`system`), not only by a team member or the human.

## Impact

- Server: new `src/server/team/memberRelease.ts` (pending releases, readiness, release execution) and its `team_member_releases` table; `TaskService.ts`/`taskStore.ts` (status-change hook, `system` journal author), `sessionMailbox.ts` (wiring, `targetWorktree` honoring `worktreeScoped`, re-evaluation on turn end, request resolution, and mailbox changes), `groupFile.ts` (three new frontmatter keys), `taskTools.ts`/`mailboxTools.ts` (`release_member`), `teamPrompt.ts` (tool note for permitted groups), `ChatSessionManager.ts` (release via the existing `archive` path; release-pending cleared on human restore).
- Shared: `src/shared/teamTasks.ts` (journal author gains `system`); client renders it as "Kawai" in `TeamTaskDetail.tsx`.
- Data: additive `team_member_releases` table; `team_task_journal.author_kind` accepts `system` (TEXT column, no migration).
- Docs: CLAUDE.md How It Works bullets (staffing, tasks, group settings); `docs/routing/README.md` group settings list.
- Coordination: `team-message-threads` turns `TaskActor` into a `TeamActor` alias; the journal-author type here is kept separate from `TaskActor` so the two changes merge cleanly. `team-waiting-reasons` reads `targetWorktree`, so its "in another worktree" reason follows `worktreeScoped` with no extra work.
