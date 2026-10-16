# Proposal

## Why

The Team page's attention queue lists every open task's unaccepted outstanding result as human-required **Pending acceptance**, owned by the human. It does so even when the result's review failed and fixes are underway, and even when the task was created by an agent (the lead), which closes the task itself once the work lands.

On 2026-10-16 the queue showed two "Needs you" acceptance items. The reviews of both results had requested changes, so neither needed the human. A queue that flags items the human cannot act on teaches the human to ignore it.

Kawai already records what it needs to tell these cases apart:
- findings are bound to the exact result they examined and carry a `pass` or `fail` verdict;
- only the human or the creator agent may close a task.

## What Changes

- **Failing findings mean fixes are pending, not acceptance.** When the newest findings bound to a result have the verdict `fail`:
  - the task's workflow stage reads **Fixes requested** (an outstanding handoff still takes precedence; this rung comes before Awaiting acceptance);
  - its next action reads **Wait for fixes**;
  - the attention queue lists an agent-owned `fixes-requested` item, owned by the result's submitter, instead of a human-required pending acceptance.
- **Pending acceptance belongs to whoever is expected to close the task.**
  - A task created by a live agent session (neither archived nor killed) lists its acceptance under agent-owned waits, owned by that session.
  - A task the human created, or whose creator agent is archived or killed, stays human-required, as today.
- **Acceptance rights are unchanged.** The human can still **Accept result** on any task from its detail, and a creator agent still closes its task by marking it done.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `team-workspace`:
  - the workflow-stage ladder now considers failing findings;
  - the owner of a pending acceptance follows the party who closes the task;
  - failing findings become an agent-owned wait.

## Impact

- **Code and tests:**
  - `src/shared/teamTasks.ts`: `TeamTaskSummary.outstandingResult` gains the verdict of the newest findings.
  - `src/server/team/taskStore.ts`: the summary.
  - `src/shared/teamTaskStage.ts`: the ladder.
  - `src/shared/teamWorkspace.ts`: the `fixes-requested` kind.
  - `src/server/team/workspaceRead.ts`: the next action and the acceptance items.
  - The client's attention-kind labels.
  - The tests for each of these.
- **AGENTS.md:** the Attention queue and Task workflow stage bullets.
- **Not changed:** no schema migration, wire message, or tool changes. The new kind travels in the existing item shape. A client that does not know the kind still renders the item with its raw kind, cause, and next action.
