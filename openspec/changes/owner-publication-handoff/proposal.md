# Proposal

## Why

Some task revisions only the human may publish: every task Kawai creates (plan
execution, override fix, promotion correction) and every task the human
created has no agent owner, so `task_amend` refuses agents and
`TaskService.publish` accepts only the owner or the human. Today an agent
that has prepared a scope or contract correction for such a task can only
describe it in prose — a journal note, mail, or a decision card. The human's
answer to that card records a decision and sends mail
(`src/server/plans/decisions/DecisionService.ts`); it does not publish a
revision, and the answered card leaves the attention queue. The correction
then exists nowhere the system tracks.

An observed team snapshot (kept as private evidence; anonymized here) showed
the result: the attention queue listed zero human items and eight agent
waits — five "Wait for fixes" items owned by archived submitters and three
Lead-owned `no-progress` stalls — while no developer or reviewer session was
running. Three Kawai-created tasks stayed at revision 1 although the human
had chosen to publish their prepared corrections. Nothing named the human as
the next actor, and the only owner-publication item in the queue
(`src/server/team/planAttention.ts`, `amendItems`) exists solely for a
convergence diagnosis decided with `Amend the contract`.

## What Changes

- Add a typed **owner-publication handoff**: an agent with task-authoring
  rights submits a prepared revision (direction, acceptance, contract,
  rationale, notify choice) for a task it may not publish, bound to the
  exact task, base revision and base contract identity, with provenance
  (requester, optional base commit, Kawai-computed payload hash, evidence
  references). It is durable, reviewable and never itself a revision.
- Give the publisher one clear action on it: **Publish prepared revision**
  (with or without editing first), or **Decline** with a reason. Publishing
  goes through the existing `TaskService.publish` path under a command key
  derived from the handoff, so it records exactly one revision and the
  existing notices, findings re-map and revision-published fact. The human
  keeps sole publication rights for unowned tasks; a live agent owner keeps
  its own.
- Track each handoff from request to an actual matching publication or an
  explicit terminal disposition (declined, withdrawn, superseded, task
  closed). A different revision published from the same base makes it
  **stale**, never fulfilled. A decision-card answer, elapsed time, session
  archival or restart never changes a handoff's state.
- Wake the next actor exactly once per transition: the requester (or its
  group, when the requester is gone) on publication, decline, staleness or
  task closure, through durable mail keyed by the handoff and transition.
- Show the handoff in the attention queue until it is fulfilled or ends:
  human-required when the task has no live agent owner, naming the base
  revision and requester. After publication, a follow-up item shows notice
  failure (**Retry notification**), awaiting acknowledgement, or that no
  session holds the task, until the current holder acknowledges.
- Make plan supervision name an open handoff on a change's task as a wait
  (`owner-publication`), so it is never reported as a Lead `no-progress`
  stall, and fold the existing post-Amend **Publish a task revision** item
  into the handoff's item when one exists. Parallel limits, dependencies,
  landing slots and execution ownership are unchanged.
- Make "fixes requested" attention truthful: when the result's submitter is
  archived or gone and no live session holds the task, the item says so and
  names who can act next instead of reading as an agent-owned wait.
- No backfill: existing tasks, cards, receipts and plans are untouched.

## Capabilities

### New Capabilities
- `task-publication-handoffs`: prepared owner-publication requests for a
  task — who may request, validation and refusals, the publisher's actions,
  the state machine to fulfillment or a terminal disposition, wakeups,
  replay, restart, and the agent tools.

### Modified Capabilities
- `team-workspace`: the attention queue lists open and stale handoffs and
  their post-publication follow-up, and names archived or missing holders
  of fixes-requested work truthfully.
- `plan-supervision`: an open handoff on a change's task is a named wait,
  and the post-Amend owner item becomes the handoff's item when one exists.

## Impact

- Server: a new handoff store and service beside `src/server/team/`
  (`TaskService.ts`, `taskStore.ts`, `taskRevisionSchema.ts`), new agent
  tools in `taskTools.ts`, a human command in `taskConnections.ts` and the
  chat connection types, the startup sweep in `sessionMailbox.ts`, attention sources in `workspaceRead.ts`,
  `attentionAcceptance.ts` and `planAttention.ts`, and the supervision
  loader and `src/shared/planSupervision.ts` wait list.
- Database: one new numbered migration (`src/server/dbSafety/migrations.ts`)
  adding handoff tables and nullable association columns on revisions and
  drafts; no change to existing rows. Going back to an older build means
  restoring the migration's pre-migration backup.
- Client: a handoff panel in the task detail (`TeamTaskDetail.tsx`, reusing
  `TaskDirectionEditor.tsx`'s diff and publish flow) and attention links.
- Docs: `docs/architecture/tasks.md`, `team-page.md`, `plan-supervision.md`,
  and a `docs/recovery-matrix.md` row for the startup reconciliation.
- No dependency, runtime-pin or plan-authority change; Stop, Retry,
  acceptance and plan approval stay the human's.
