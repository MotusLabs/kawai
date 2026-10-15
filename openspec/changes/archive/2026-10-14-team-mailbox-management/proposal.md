# Proposal

## Why

When an agent gets stuck — typically on a provider limit — clearing the way for a replacement is human-only work, and stale mail keeps causing trouble after the stuck agent is gone. On 2026-10-14 a GLM dev hit its 5-hour limit holding parked review work. The lead could only tell the human which messages to cancel, by ids the Mailbox panel does not show. Then archiving the dev freed its worktree, and a 90-minute-old follow-up the lead had queued to `middle-devs` spawned a duplicate Sonnet dev that redid finished work. The lead was the sender, yet it had no tool to see that the message was still queued, and none to withdraw it. Today:

- Every mailbox action — cancel, retry, discard, hand off — exists only on the human's WebSocket (`mailboxConnections.ts`); the `kawai-team` server has no read or cancel tool, so the lead inspected `agentboard.db` with raw SQL.
- Parked work cannot be dropped at all: `MailboxStore.cancel` accepts only `queued`/`awaiting-request`, and the panel offers parked rows only **Hand off**, which spawns more work.
- Mailbox rows show no message id, so ids quoted by an agent cannot be matched to rows.

`team-member-release` (in flight) lets an opted-in lead archive a finished spawned member, but refuses a member that holds claimed or parked mail. A stuck member holding parked work is exactly the one the lead needs to clear, so release stays blocked on the human until that mail can be dropped.

## What Changes

- **Senders withdraw their own mail.** Any agent can cancel a message it sent while it is still undelivered: queued, scheduled, or held awaiting the recipient's request. Mail that is claimed, being spawned for, or delivered is never cancellable.
- **Mailbox managers.** A group whose file sets `canManageMailbox: true` (default `false`) may cancel any message of its team in those states, and also `parked` mail. It may discard `dead` and `uncertain` mail. Retry and Hand off stay human-only. This repository's `.kawai/groups/lead.md` sets it for the Team Lead.
- **Cancelling parked work ends the park.** The parked message and its waiting resume mail are cancelled together. The holder is no longer paused, is not restored or resumed, and holds no mail, so a release can proceed. While the resume turn is already running, the cancel is refused until that turn ends. A resume linked to parked work is never cancelled on its own, by an agent or the human, so parked work is never left without a resume.
- **Agents can inspect the mailbox.** A read tool lists unsettled team mail with id, state, sender, recipient, claimant, task, age, due or resume time, reason, the waiting blocker, and a truncated body. Filters cover state, recipient, sender, and task. Plain members see only mail they sent, mail addressed to them, and mail they hold. Managers see the whole team.
- **Attributed and journaled.** Agent cancels and discards require a reason. Message history records the acting agent (a new `agent` event actor with its session id) and that reason. A message under a task gets a journal note by the acting agent.
- **Human mailbox panel.** Parked rows gain **Cancel** with the same semantics as the agent tool. Every row shows its short message id, with the full id available to copy.
- **Prompt.** The mailbox note describes withdraw and inspect to every agent. It describes cancel-any and discard only to groups that hold `canManageMailbox`.

Non-goals:
- Agent retry or hand-off of any message, or cancelling claimed, spawning, or delivered mail.
- Notifying a holder that its parked work was cancelled. The event history records it, and an archived holder stays archived.
- Changing archive or restore semantics, including direct mail restoring an archived recipient.
- Releasing or archiving sessions; `team-member-release` owns that.
- Settled history in the read tool: the Messages view and its query cover delivered mail.

## Capabilities

### New Capabilities

- `team-mailbox-management`: agent mailbox tools and rights. Covers sender withdrawal, the `canManageMailbox` group setting, manager cancel and discard, parked-work cancellation, the scoped read tool, attribution of agent actions in message history and task journals, and refusals.

### Modified Capabilities

- `agent-mailbox`: the human can cancel parked mail from the Mailbox panel, and mailbox rows show their message ids.

## Impact

- Server: `mailboxStore.ts` (parked cancel together with its resume mail in one transaction; actor-aware cancel and discard), `messageEvents.ts` (`agent` actor plus a nullable `actor_session` column), a new `mailboxManagement.ts` service (rights, scoping, refusals, journal note), `mailboxTools.ts` (`cancel_message`, `discard_message`, `list_mailbox`), `groupFile.ts` (`canManageMailbox`), `teamPrompt.ts`, `mailboxConnections.ts` (human cancel of parked rows through the same store path), `routing/limitOutcomes.ts` (resume replacement through the store's linked-resume path; defensive tolerance of cancelled work).
- Shared: `src/shared/team.ts` (`MessageEventActor` gains `agent`; `MessageEvent.actorSession`).
- Client: `TeamMailboxPanel.tsx` (Cancel on parked rows, short ids); the Messages thread history labels agent actors by name.
- Data: an additive nullable `actor_session` column on `team_message_events`; no other schema change.
- Config and docs: `.kawai/groups/lead.md` (`canManageMailbox: true`), CLAUDE.md How It Works bullets, and the group settings list in `docs/routing/README.md`.
- Coordination: `team-member-release` counts parked mail as held, so a manager's parked cancel makes a stuck member releasable, with no code dependency either way. Both changes touch `groupFile.ts`, `mailboxTools.ts`, and `teamPrompt.ts`; whichever merges second rebases. Task assignment already derives `failed` from a cancelled or discarded instruction, so an agent's cancel frees the task for reassignment unchanged.
