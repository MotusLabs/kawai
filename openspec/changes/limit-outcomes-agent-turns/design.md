# Design

## Context

`LimitOutcomes` (`src/server/team/routing/limitOutcomes.ts`) learns about a turn's work only from `delivered(sessionId, message)`, which maps a resume to its parked work. It forgets that work in `turnEnded`. A final limit event for the session is held in `pending` until the turn ends. `turnEnded(session, success)` resolves the work when both are present. When the turn ended successfully with no limit event, it unparks parked work. A turn with no delivered work, whether human or agent-started, therefore resolves nothing on a limit, and the success path cannot tell an agent-started turn from a human one.

The driver opens agent-started turns from a `system/init` that arrives while no turn is active. Their `turn_started` carries a `trigger` (`task` or `resumed`). User sends and peer deliveries open turns without one.

## Decisions

### D1. Agent-started turns are known from `turn_started.trigger`

`ChatSessionManager` passes each `turn_started` to `SessionMailbox.turnStarted(sessionId, agentStarted)`, where `agentStarted` is `event.trigger !== undefined`. That method forwards to `LimitOutcomes.turnStarted`, which sets or clears a per-session flag. Every turn start resets the flag, so an interrupted turn cannot leak it into the next one. A user send that races the self-start joins the open turn, and the turn keeps the kind it opened with.

### D2. Current work: last delivered, else derived from the store

`delivered()` also records `lastWork[session] = workId` (the resume's parked work, or the message itself), and so does a park. Unlike `active`, this record survives `turnEnded`. `currentWork(session)` returns `lastWork` while the store row is still held, which means it is `delivered` or `parked` and claimed by that session. Otherwise it falls back to a store query, so the answer also holds after a restart:

- the session's parked message, newest `parked_until` first;
- otherwise its newest held `delivered` message by `delivered_at`, excluding `resume`-tagged rows, because a resume is a pointer to its work and not work itself.

Forwarded, released, and cancelled messages are not held, so they never count.

### D3. Resolution for an agent-started final limit

`turnEnded` takes the agent-turn path when a final event is pending, the turn has no delivered work, and the turn was agent-started. The result subtype is ignored, because the CLI has reported `success` after a final limit. Given the current work W:

- If W is `delivered` and has fewer than `MAX_PARKS` (3) parks, it is parked through the existing `park()`. That replaces any resume, enqueues the `resume`-tagged message at the reset, and increments the count. The policy, the rule's `onLimit`, and progress are not consulted, and W is never released or forwarded.
- If W is already `parked`, the resume is replaced by one at the later of the two reset times, and the park count stays the same. The store gets `park(id, until, resume, { count: false })`.
- If W is `delivered` with `MAX_PARKS` parks, nothing is done. It is not released, because the instruction may be complete. The resume-turn path keeps its existing rule: a resume turn that hits a limit again with 3 parks releases the work.
- If there is no current work, nothing is resolved.

When the reset has already passed, `park()` is skipped, as in the existing path. The agent is not paused for a limit that has already recovered.

### D4. Successful agent-started turns do not unpark

The success path unparks only for human turns, meaning turns with no delivered work that are not agent-started, and for the work's own resume. A successful agent-started turn leaves parked work and its resume alone, so the resume still arrives.

## Risks

- **Parking finished work.** If W was already complete, the agent is paused until the reset and then told to continue from W. That costs one short turn. Releasing or forwarding instead could repeat finished work on another agent, and leaving the agent stranded is today's failure.
- **Stale current work.** If the agent's last delivered message was a short notice, such as a revision notice or a reassignment note, that notice is the message that gets parked. The resume names it, and the agent decides what to continue.
