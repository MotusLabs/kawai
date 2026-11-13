# Design

## Context

`taskOwner(task)` in `src/server/team/taskStatusRights.ts` is the single
reading of ownership: `owner_session` when set, otherwise the creating agent
session, and null for a human-created task. The amend and close checks
already use it. Two creator reads are left:

- `FindingDisputes.dispute` mails `task.creator.sessionId`, and
  `FindingDisputes.decide` checks `task.creator.sessionId === actor.sessionId`.
- `ExhaustionNotes.recipientFor` falls back to `task.creator` when no
  assignment names a dispatcher.

## Decisions

### D1 Disputes follow the owner

`decide` allows the human, or an agent whose session is `taskOwner(task)`.
The refusal names the owner, using `ownerLabel(task)`: "Only the task's owner
(<id>) or the human decides a dispute; nothing was written". A human-created
task (owner null) can be decided only by the human, as before. The dispute
mail goes to `taskOwner(task)` when it is non-null, and nobody gets mail when
it is null, as with a human creator today.

Ownership is read when the dispute is filed. If the owner changes between the
dispute and the decision, the new owner decides. The mail already sent stays
with the old owner, which is acceptable: `task_transfer_owner` journals the
move, and the ledger shows the dispute to anyone who reads the task.

### D2 The exhaustion note falls back to the owner

`recipientFor` takes the owner session id instead of the creator. The
eligibility rules are unchanged: never the human, the flagged session itself,
or a killed, archived, or flagged session. An owner that is context-exhausted
therefore leaves the item with the human, as a flagged creator does today.

### D3 Team files

- `change-leads.md` recovery paragraph, proposed text for the human's review:

  > If you become unavailable, participants escalate once to `lead` and
  > dispatch nothing; prefer compacting your session over replacing it. A
  > replacement coordinates new work within its own rights. Once you are
  > archived, gone, or context-exhausted, it may take over your tasks with
  > `task_transfer_owner` and `from_session`, which journals each move;
  > while you are live it never takes them, and you or the human amend and
  > close them. On withdrawal, hand your open tasks to your successor with
  > `task_transfer_owner` and `to_session`, coordinate the safe checkpoint,
  > keep the role until dependent work resolves, and preserve every
  > journal, result, and reference.

- `lead.md`: `max: 2`. The profile of the second lead is the human's choice
  at creation time; the guidance asks for a non-Anthropic one, so the two
  leads do not draw on one Anthropic limit. Group `profile: default` stays
  unchanged.

## Risks

- A test fixture that relied on `lead.md` `max: 1` would break. The shipped
  group file is read only by `teamGroupFile.test.ts`, whose assertions do not
  name `max`. Verify by running it.
