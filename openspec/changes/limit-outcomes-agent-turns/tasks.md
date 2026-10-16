# Tasks

## 1. Turn kind and current work

- [ ] 1.1 Forward `turn_started` from `ChatSessionManager` to `SessionMailbox.turnStarted(sessionId, agentStarted)` (`agentStarted` = the event has a `trigger`) and on to `LimitOutcomes.turnStarted`, which keeps a per-session agent-turn flag reset on every turn start. Verify with a `limitOutcomes` unit test and the manager wiring test.
- [ ] 1.2 Add `MailboxStore.heldBy(sessionId)` (claimed by the session, `delivered` or `parked`) and `LimitOutcomes.currentWork(sessionId)`: the last delivered or parked work while still held, else the newest parked, else the newest held non-`resume` delivered message. Verify with unit tests covering a released, forwarded, or cancelled last work falling back, the resume-to-work mapping, and derivation after a fresh `LimitOutcomes` (restart).

## 2. Agent-started limit resolution

- [ ] 2.1 In `turnEnded`, when a final event is pending, no delivered work is active, and the turn was agent-started, park the current work: `delivered` under `MAX_PARKS` → `park()`; already `parked` → resume replaced at the later reset with the count unchanged (`park(..., { count: false })`); `MAX_PARKS` reached or no current work → nothing. The result subtype is ignored. Verify with `limitOutcomes` tests for each branch, including a `success` result after a final limit and a 5-hour reset with `otherwise: forward`.
- [ ] 2.2 Restrict the success unpark to human turns and the work's own resume. Verify a successful agent-started turn leaves the parked work and its resume, a successful human turn still unparks, and a successful resume turn unparks.
- [ ] 2.3 Integration test (real manager, driver, mailbox): delivered work completes, then a self-started (task notification) turn ends after a final limit → the work is parked with a resume at the reset; with no held work nothing changes.

## 3. Checks

- [ ] 3.1 `openspec validate limit-outcomes-agent-turns --strict` and `openspec validate --specs --strict` pass.
- [ ] 3.2 `bun run lint && bun run typecheck && bun run test` pass.
