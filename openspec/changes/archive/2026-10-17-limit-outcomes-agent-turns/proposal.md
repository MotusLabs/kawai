# Proposal

## Why

Limit outcomes cover only turns that handle a delivered message. If the agent starts a turn itself, from a background-task notification, a Monitor, or a `resumed` start, and that turn ends at a final provider limit, Kawai resolves nothing. No message is parked and no resume is scheduled. The agent then sits waiting until a human notices.

This happened on 2026-10-16. After an urgent interrupt, a dev's real work ran as an agent-started turn. It ended at a final Z.AI limit that reset three hours later, and the dev was stranded. The interrupt race that pushed the work into an agent-started turn is fixed separately on the same branch. However, agent-started turns hit limits on their own too: a Monitor fires while the agent is mid-task, or a background build finishes.

A second detail from the incident is that the CLI reported that turn's result as `success`, even though its last assistant message carried the final limit. A turn's result subtype therefore cannot decide limit outcomes. The recorded final limit event decides them.

## What Changes

- When a turn the agent started itself ends after a final limit event, Kawai parks the session's **current work** on that agent and schedules its resume at the reset. This is the newest message delivered to, parked on, or resumed by the session that it still holds.
- Such a limit never releases or forwards the work. The instruction may already be complete, so handing it to another agent could repeat finished work. The group's and the rule's `onLimit` are not consulted, and the work does not need to have made progress.
- With no current work, nothing is resolved, as today.
- Work that is already parked stays parked. Its resume moves to the later reset, and its park count does not change, so a Monitor that fires repeatedly during a cooldown cannot use up the park limit.
- Work already parked 3 times (`MAX_PARKS`) is not parked again by an agent-started turn, and it is not released either. It is left as it is, which is today's outcome for this case.
- A successful agent-started turn no longer unparks work. Only a human turn or the work's own resume does, as the existing code comment already intends. Today a successful agent-started turn is indistinguishable from a human turn and cancels the resume.
- Turns that handle delivered mail and human turns behave exactly as before.

## Capabilities

### Modified Capabilities

- `profile-limit-handling`: adds the requirement that a final limit in an agent-started turn parks the current work. It also states the park-limit and unpark rules for that case.

## Impact

- `src/server/team/routing/limitOutcomes.ts`: track whether the current turn was agent-started, track each session's last work, and add the agent-turn park path.
- `src/server/team/mailboxStore.ts`: a held-work query, and a park that leaves the count unchanged when the work is already parked.
- `src/server/team/sessionMailbox.ts` and `src/server/chat/ChatSessionManager.ts`: forward `turn_started` and whether the turn is agent-started (the turn's `trigger`) to limit outcomes.
- No schema change, no new wire message, and no UI change. The parked badge, the resume, and the Mailbox rows are the existing ones.
