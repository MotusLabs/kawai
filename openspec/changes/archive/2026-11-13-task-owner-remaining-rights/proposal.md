# Proposal

## Why

`group-mail-task-affinity` gave every task an owner. The owner amends the
task, closes it, and gets its group mail, and `task_transfer_owner` moves
ownership. Two rights still follow the creator:

- **Manual finding disputes.** Only the creator or the human may decide a
  dispute on a task outside a plan, and the dispute mail goes to the creator.
  After a handover, the new owner can close the task but cannot settle a
  finding that blocks it. A creator that left gets mail it can never act on.
- **The context-exhaustion note fallback.** When a flagged session's task
  has no outstanding assignment, the note goes to the task's creator, even
  after the creator handed the task to another lead.

Two team files also disagree with the new model:

- `.kawai/groups/change-leads.md` still says a replacement "cannot amend or
  close your children; the original creator or the human does that". The
  `change-coordination` spec now lets a replacement take over a departed
  coordinator's tasks through `task_transfer_owner`, but never a live one's.
- `.kawai/groups/lead.md` still sets `max: 1`, so the team cannot run the
  second lead the shared lead mailbox was designed for.

## What Changes

- The task's owner, not its creator, decides manual finding disputes (the
  human still can), and the dispute mail goes to the owner.
- The context-exhaustion note falls back to the task's owner when no
  assignment names a dispatcher.
- `task_decide_dispute`'s description says "a task you own".
- The change-leads recovery paragraph describes takeover through
  `task_transfer_owner` once the coordinator is gone, archived, or
  context-exhausted, and never while it is live. This text needs the human's
  review before it lands.
- `lead.md` allows two leads (`max: 2`). The human creates the second lead on
  a non-Anthropic profile.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `review-findings`: the owner decides manual disputes and receives their mail.
- `context-exhaustion-recovery`: the decision note falls back to the owner.

## Impact

- Code: `src/server/team/findingDisputes.ts` and
  `src/server/team/exhaustionNotes.ts` use `taskOwner(task)`;
  `src/server/team/taskTools.ts` updates the tool description.
- Team files: `.kawai/groups/change-leads.md` and `.kawai/groups/lead.md`.
- Tests: `findingDisputes.test.ts`, `contextExhaustion.integration.test.ts`,
  and `teamGroupFile.test.ts`.
- No migration. Tasks created before ownership have
  `owner_session = creator`, so their behaviour is unchanged until ownership
  moves.
