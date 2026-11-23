# Proposal

## Why

An agent can prepare an exact task revision for publication, and a human can answer a plan decision. When the question asks the human to publish the prepared revision, the human still has to find the handoff and publish it separately. The decision history alone cannot show which revision the human agreed to publish or whether it was published.

## What Changes

- Keep `task_request_publication` and `task_get { task_id, handoff_id }` for preparing and reading handoffs. Add the optional `publication_handoff_id` to `decision_ask`. The handoff's persisted task determines the card's plan and change. The original requester can bind or replay it when the target plan currently routes their question to the human, regardless of the session's task focus.
- Show the task, handoff, published base, complete before and after content, and prepared rationale from the card. The human selects **Approve and publish** to record a decision and publish those exact fields through the existing prepared publication path. An **Answer without publishing** still records a decision independently of the handoff.
- Record the human decision, task revision, handoff disposition, and original notice references together. A stale review or a competing action can refuse with no partial writes. An exact retry returns the recorded receipt.
- Use the existing direct revision notice for the current assignment holder and the existing handoff wakeup for the requester. The writer still explicitly acknowledges the revision when working from it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plan-decisions` adds a typed handoff binding, exact human review and approval, and a decision with a durable publication receipt.
- `task-revision-publication` specifies prepared publication provenance, notice semantics, and execution boundaries when the human publishes from a decision card.

## Impact

The change adds a small decision-store migration, an optional agent tool argument, two human connection messages for review and approval, and a Plans view action. It uses the shipped `owner-publication-handoff` capability and the current task publication and mailbox services. Existing agent tool calls and ordinary cards continue to work. Older fixed tool catalogues need a fresh session to expose the new argument.

The human publishes directly. Task ownership, plain task publication and edited drafts, plan and strategy approval, Kawai stage ownership, holds, pause resolution and Adapt, Stop/Retry, and result acceptance keep their current rules. This change grants no publisher role and infers no links from historical cards or prose. It is a standalone change. Any implementation and review follow a separately assigned task.
