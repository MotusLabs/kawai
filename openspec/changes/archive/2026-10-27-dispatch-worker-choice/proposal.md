# Proposal

## Why

The lead dispatches work but can't see how much quota each provider has left, and can't choose where the work runs. Usage, reset times and cooldowns reach only the human's usage bar and routing rules. The dispatch tools take no profile, so group routing picks one by strategy. So when the current provider is nearly spent and its reset is hours away, the lead can't start the work on another provider, though that may be the only way to finish before the reset.

The 2026-10-18 context-exhaustion incident (dev chat-e94dc0fc, see `chat-context-exhaustion`) made this concrete: the right recovery depended on progress, quota and reset time together. Only the lead knew the progress, and nothing let it act on the rest. The human asked for both features as general dispatch features, not only for that recovery.

## What Changes

- **Agents can read team capacity.** A new read-only `team_capacity` tool on the `kawai-team` server returns:
  - for each provider of a group's workers: usage per window (with its source), reset time, and cooling-until;
  - for each worker: its cap and live count.
  - The data is what kawai already holds for routing rules. Nothing new is fetched, and nothing is persisted.
- **Dispatch takes an optional worker choice.** `send_message`, `schedule_message` and `task_handoff` accept an optional `worker`:
  - either a provider (any of that provider's models the target group lists) or `provider/model`;
  - it must be among the target group's workers, and anything else is refused with nothing queued.
- **Routing honors it as a hard filter.** For group mail, only members and spawn slots on the chosen worker are candidates. Group, worker and team spawn caps and worktree occupancy still apply, and routing rules see the choice as a constraint they cannot override. The choice is stored on the message, so delivery, staffing and waiting reasons read it.
- **The human's dispatch gets the same choice.** **Create and assign** and **Assign / send task** offer it, and the dispatch preview shows its effect.
- **Not changed:**
  - groups' own `workers`, `strategy`, and `onLimit` settings;
  - limit outcomes;
  - how usage is gathered;
  - Kawai's plan-execution dispatches, which take no worker choice.

## Decisions taken while specifying

- **Cooling choice (the human's call):** a send naming a cooling provider is accepted. The mail waits with a waiting reason until the cooldown ends.
- **Direct mail:** a `worker` on mail to a session or to the human is refused, since a session's model is fixed.
- **Replay:** the choice is part of the request-key payload identity of assignments and handoffs.
- **Limit forwards:** a forward drops the choice; its exclusion of the limited worker governs.
- **Eligibility is one reusable pure check (the human's call, PR #221).** The check takes a group, a choice and a stated routing state, and returns the eligible workers plus a reason for each excluded alternative. Routing uses it. `process-observability` D12 can call it at an incident cutoff instead of reading the last pass's record (design D10).
- **No choice on plan-execution dispatches (the human's call, PR #221).** Kawai's own plan-execution instructions and handoffs never carry a worker choice in this change. Roles alone narrow them.
- **Shared logins are flagged (the human's call, PR #221).** `team_capacity` marks providers that share one login, so switching between them is never presented as escaping a quota window. Sharing is detected by a stated rule and never assumed (design D6).

## Dependencies

- **`providers-and-workers`.** This change builds on it:
  - #219 landed its catalog, `workers` keys, `providerOf`, and provider cooldown (§1–4).
  - Provider-keyed usage (§5) and `ctx.providers` (§6) landed in #241; `providers-and-workers` was archived in #242. This change builds on that landed state.
  - Before provider keys, a per-profile choice would treat two models of one account as independent, so "switch provider" would not mean anything.
- **Plan-execution D15.** This change reuses its role filter (`team_messages.allowed_profiles`, `CandidateInput.allowedProfiles`). The worker choice narrows it rather than adding a second candidate filter (design D2).
- **`codex-chat-sessions` (#220 PR A, #240 PR B; change still open).** It adds Codex providers (`codex-home-<12 hex>`) and caches their usage per home. A choice may name one like any provider.
- **`process-observability` D12.** Its recommendations call this change's eligibility check (design D10).

## Capabilities

### New Capabilities
- `agent-capacity-view`: what agents can read about their team's provider usage, cooldowns, caps, live counts and shared logins.

### Modified Capabilities
- `agent-mailbox`: `send_message` and `schedule_message` accept a worker choice and store it on the message.
- `task-results`: `task_handoff` accepts a worker choice.
- `task-assignment`: human dispatch and its preview carry a worker choice.
- `team-routing-rules`: routing filters candidates and spawn slots by a message's worker choice, and rules see it as a constraint. Eligibility is one reusable pure check that returns exclusion reasons.
- `team-worktree-staffing`: spawning for a message with a worker choice uses that worker.
- `team-waiting-reasons`: mail held by its worker choice names it in its reason.

## Impact

- `src/server/team/mailboxTools.ts`, the task tools, and `AssignmentService` (the new argument and its validation).
- `team_messages` and `team_task_assignments` each gain a nullable column through a new numbered migration (the next free number at landing; 15 `codex-chat-runtime` and 16 `plan-supervision` are taken).
- `src/server/team/sessionMailbox.ts` and the dispatcher, which intersect the choice with the role filter that `candidates.ts` already applies.
- `memberCauses.ts`, for the `worker-choice` cause.
- A new pure eligibility module under `src/server/team/routing/`, which routing and `process-observability` share.
- `src/shared/routing.ts`, the type-only rule contract, gains an additive field.
- The task form, the dispatch preview, and the system prompt's mailbox note.
