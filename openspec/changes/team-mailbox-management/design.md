# Design

## Context

See proposal.md (Why). The relevant current state:

- **Store transitions.** `MailboxStore` owns every state change through `transition(id, from[], set, kind, actor)`. That method runs the conditional `UPDATE … WHERE state IN (…)` and appends a `team_message_events` row inside one transaction (`logged`). `cancel(id)` accepts `queued`/`awaiting-request`; `discard(id)` accepts `dead`/`uncertain`. Both currently log the actor as `system`, even when the human triggered them. `limitOutcomes.ts` also calls `cancel` internally on resume messages.
- **Parked work.** A parked message is one with `state = 'parked'`, `claimed_by` set to the holder, `parked_until`, and `resume_message_id`. The resume message is an ordinary queued direct message to the holder, due at the reset. `ChatSessionManager.refreshParked` derives `Session.parked` from `store.parkedBy()` on every store change, so a parked row leaving `parked` clears the badge without extra wiring. `LimitOutcomes` tracks the active work per session (`active`) and resolves it when a turn ends. A success unparks it with `transition(['parked'] → delivered)`, which is a no-op once the row has moved on.
- **Human actions.** These go through `MailboxConnections`. The connection checks the row's team against the requesting chat's team, calls the store, then calls `dispatcher.notify()` and `publish(teamId)`.
- **Agent tools.** These are built per agent start in `mailboxTools.ts`. Handlers bind the caller's session id, and services refuse by throwing; the error text becomes the tool result. Rights flags such as `canCreateTasks` are read from the group's current file at call time through `loadTeamGroups`.
- **Waiting reasons.** These are held in memory by the dispatcher (`waitingReasons.ts`) and carried in the mailbox snapshot keyed by message id.
- **Task assignment.** An assignment's state derives from its instruction mail, so `cancelled` and `discarded` already read as `failed`.

## Goals / Non-Goals

**Goals:**
- One store path per action, shared by the human panel and the agent tools, so the rules for "which states are cancellable" and "parked cancel cascades to the resume message" cannot diverge.
- Rights decided in one service, from the calling session's live record and its group's current file.
- No new tables. History attribution extends the existing event log.

**Non-Goals:**
- Paging or settled history in `list_mailbox`; the Messages view's query covers that.
- Any change to dispatch, routing, staffing, or receipt logic.

## Decisions

### D1. A `MailboxManagement` service owns agent rights; the store stays rights-free

A new `src/server/team/mailboxManagement.ts` exposes `cancel(caller, {message_id, reason})`, `discard(caller, {message_id, reason})`, and `list(caller, filters)`. For each call it:
1. Resolves the caller's record and team (`resolveTeam(projectPath)`), and loads its group through `loadTeamGroups`, as `TeamMailbox.context` does.
2. Loads the message. If it is absent or belongs to another team, it refuses with "Message not found in this team: <id>", never revealing that the message exists elsewhere.
3. Decides the right: the caller is the sender (`from_kind = 'agent' AND from_session = caller`), or it holds management (`group.canManageMailbox`). Parked cancels and all discards require management.
4. Checks the state against the action's allowed set before writing, and refuses with the current state named (for example "claimed by <session>" or "a member is starting for it"). The store's conditional update remains the authority under races. A `false` from the store maps to "Message state changed to <state>; nothing was cancelled".
5. Calls the store with `actor: { kind: 'agent', sessionId }` and the reason, then appends the task journal note (D5).

The alternative was putting the rights checks in `TeamMailbox`, next to send. It was rejected because send is identity-bound composition, while this is an authorization layer over arbitrary rows. A separate file keeps `TeamMailbox.ts` small and gives tests a single seam. The tool handlers call the service exactly as `taskHandlers` call `TaskService`.

### D2. Parked cancel is one store transaction that also cancels the resume message

`MailboxStore.cancel(id, actor, reason)` widens its accepted states to `queued`, `awaiting-request`, and `parked`. When the row is parked, the same transaction:
- transitions the row `parked → cancelled`, clearing `parked_until` and `resume_message_id`;
- transitions the resume message `queued → cancelled` with the same actor and the reason "parked work <id> cancelled", if it is still queued.

If the resume message is already claimed or delivered, it is left alone (spec scenario "Resume already delivered"). Internal callers in `limitOutcomes.ts` cancel only resume messages, which are never parked, so widening the accepted states does not change their behavior.

Rights do not live in the store: the human panel may cancel parked rows, and agents need management, which D1 enforces. `LimitOutcomes` must tolerate a cancelled row:
- `resolve()` on a final limit for work that is no longer `parked` or `delivered` drops the work (its `active` entry and digest) instead of re-parking or forwarding it;
- a successful turn's `unpark` is already a no-op.

The alternative was a separate `cancelParked` method. It was rejected because two cancel entry points with different state sets is exactly the drift D1's goal forbids.

### D3. Agent actors in the event log: `agent` plus a nullable `actor_session` column

`MessageEventActor` becomes `'system' | 'human' | 'agent'`, and `team_message_events` gains a nullable `actor_session TEXT`. It is added with a guarded `ALTER TABLE … ADD COLUMN` if missing, matching the additive column pattern `messageSchema.ts` already uses. `MessageEvent.actorSession` is non-null only for `agent`. Store methods take an actor object (`{ kind: 'system' } | { kind: 'human' } | { kind: 'agent'; sessionId }`), and `recordEvent` writes both columns. The event `reason` carries the agent's reason, for example "parked work <id> cancelled" on a cascaded resume.

While here, the human panel's cancel, retry, and discard pass `{ kind: 'human' }`. The shipped history spec already says these are the human's actions; today they log as `system`. This fixes that latent mismatch rather than adding a new behavior.

The Messages thread history renders an agent actor with the participant label it already resolves for senders, live or `(gone)`.

The alternative was writing the agent's session into the `reason` text. It was rejected because history is meant to name participants and link them, and free text cannot be resolved.

### D4. The row's `reason` records why it was cancelled

Cancel and discard by an agent also set the row's `reason` to `cancelled by <session>: <reason>` or `discarded by <session>: <reason>`, with the agent's text cut to 300 characters. Task assignment shows a failed instruction's reason from the row. The Mailbox and Messages views already render `reason`, so the human sees why work vanished without opening history. Human actions keep their current row shape: no reason.

### D5. Task journal note by the acting agent

When the message has a `task_id`, the service appends a journal note through `TaskService.note(caller, …)` as the acting agent. A note is a right every team member already has, so team-tasks needs no change. The note reads: "Cancelled message <id> to <recipient> (<state before>): <reason>". A cascaded resume message gets no separate note. Journal failure (for example a task deleted mid-call) is logged, never rolled back into the mailbox action: the event log stays the record. Human panel actions add no journal note, as today.

### D6. `list_mailbox` reads the existing team listing, then scopes and projects it

The service calls `store.listForTeam(teamId)`, the same unsettled set as the panel. For non-managers it filters to rows where `from_session = caller`, or `to_kind = 'session' AND to_id = caller`, or `claimed_by = caller`. It applies the optional filters (`state[]`, `to`, `from`, `task_id`) and projects each row to:

`{ id, state, priority, from: {kind, session, group}, to: {kind, id}, claimedBy, taskId, createdAt, ageMinutes, deliverAt, parkedUntil, reason, waiting, body }`

- `waiting` is the row's current blocker label from the dispatcher's in-memory reasons, or null.
- `body` is cut to 300 characters, with a flag marking the cut.
- Output is capped at 100 rows, newest first, with a count of rows omitted.

Group mail to the caller's group is deliberately excluded for non-managers. It is shared work the caller has not taken, and showing it adds noise without granting any action.

### D7. `canManageMailbox` is a warning-level flag

`groupFile.ts` parses `canManageMailbox` like `effort`: an invalid value adds a warning and leaves `false`. Today an invalid `canCreateTasks` invalidates the whole group file. That is wrong for a rights flag: a typo would drop the group's role prompt and membership, when the failure should stay limited to this one right. The tool is always registered for every agent and refuses by right. That matches the rest of the task tools, and means editing a group file never requires re-registering MCP tools. Only the prompt note (D8) is per-group and re-read at agent start.

### D8. Prompt note

`mailboxNote` gains lines for `list_mailbox` and `cancel_message` (own undelivered mail) for every agent. When `group.canManageMailbox` is true, it also gains lines for managing any team message (including parked work, whose resume message is cancelled with it) and `discard_message` (dead or uncertain), plus the rule "retry and hand-off stay with the human". It also advises: "before archiving or replacing a stuck agent, list and cancel the mail that would restore or respawn it". That sentence turns the incident in the proposal into standing guidance.

### D9. Human panel

- `TeamMailboxPanel` shows **Cancel** for `parked` rows too, beside `ParkedHandOff`, sending the existing `team-mailbox-cancel`. No new client message type, so the WebSocket router whitelist is unchanged.
- Each row's header line starts with the first 8 characters of the id in monospace. The full id is in its `title`, and a copy button sits beside it.
- `MailboxConnections` already maps a `false` store result to "Message state changed; this action is no longer available".

## Risks / Trade-offs

- [A manager cancels parked work that was about to resume successfully] → The cancel is deliberate and attributed. The holder keeps its working tree, and the journal note and history show what was dropped. The human can re-send.
- [A delivered resume turn keeps running after its parked message is cancelled] → It cannot be stopped without interrupting an agent, which this change does not do. Its outcome is ignored (D2), and the cancel's journal note tells the lead to message the holder if needed.
- [Non-managers see less than the panel shows] → Intentional. The panel is the human's whole-team view, and agents get the least visibility they need.
- [Overlap with `team-member-release`'s `release_member`] → Independent. This change only makes "holds no claimed or parked mail" reachable without the human. Shared files are rebased by whichever change merges second.
- [Event-log consumers that assume the actor is `system` or `human`] → `mapEvent` and the client label switch are updated in the same task. Unknown actors render as `system`.

## Migration Plan

Additive only: a nullable column added if missing, a new optional frontmatter key, and new tools. Existing events keep `actor_session` null. Rollback leaves an unused column. `.kawai/groups/lead.md` gains `canManageMailbox: true` in the same PR; a running lead picks up the right at its next call, and the prompt note at its next agent start.
