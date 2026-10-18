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
  - how usage is gathered.

## Decisions taken while specifying

- **Cooling choice (the human's call):** a send naming a cooling provider is accepted. The mail waits with a waiting reason until the cooldown ends.
- **Direct mail:** a `worker` on mail to a session or to the human is refused, since a session's model is fixed.
- **Replay:** the choice is part of the request-key payload identity of assignments and handoffs.
- **Limit forwards:** a forward drops the choice; its exclusion of the limited worker governs.

## Dependencies

- **`providers-and-workers`.** This change builds on it:
  - #219 landed its catalog, `workers` keys, `providerOf`, and provider cooldown (§1–4).
  - Provider-keyed usage (§5) and `ctx.providers` in the rule contract (§6) are still pending. This change starts after them.
  - Before provider keys, a per-profile choice would treat two models of one account as independent, so "switch provider" would not mean anything.
- **Plan-execution D15.** This change reuses its role filter (`team_messages.allowed_profiles`, `CandidateInput.allowedProfiles`). The worker choice narrows it rather than adding a second candidate filter (design D2).
- **`codex-chat-sessions` (#220).** It adds Codex providers (`codex-home-<hash>`) and caches their usage per home. A choice may name one like any provider.
- **`process-observability` D12.** Its recommendations read the allowed workers and exclusion reasons that this change produces (design D10).

## Open questions

- Should the eligibility for a group and choice (its allowed workers, and why each alternative is excluded) be a reusable pure function? `process-observability` D12 could then call it outside a dispatch pass. The alternative is that D12 reads the cause reporter's output from the last pass.
- Should a choice also be allowed on Kawai's own plan-execution dispatches, narrowing a role? Or should it stay agent- and human-only?
- Should `team_capacity` mark providers that share a login but are declared separately (for example two Claude profiles on one claude.ai account)? Or should that be left to `providers.json`?

## Capabilities

### New Capabilities
- `agent-capacity-view`: what agents can read about their team's provider usage, cooldowns, caps and live counts.

### Modified Capabilities
- `agent-mailbox`: `send_message` and `schedule_message` accept a worker choice and store it on the message.
- `task-results`: `task_handoff` accepts a worker choice.
- `task-assignment`: human dispatch and its preview carry a worker choice.
- `team-routing-rules`: routing filters candidates and spawn slots by a message's worker choice; rules see it as a constraint.
- `team-worktree-staffing`: spawning for a message with a worker choice uses that worker.
- `team-waiting-reasons`: mail held by its worker choice names it in its reason.

## Impact

- `src/server/team/mailboxTools.ts`, the task tools, and `AssignmentService` (the new argument and its validation).
- `team_messages` and `team_task_assignments` each gain a nullable column through a new numbered migration (13 or later; 12 is the latest on master).
- `src/server/team/sessionMailbox.ts` and the dispatcher, which intersect the choice with the role filter that `candidates.ts` already applies.
- `memberCauses.ts`, for the `worker-choice` cause.
- `src/shared/routing.ts`, the type-only rule contract, gains an additive field.
- The task form, the dispatch preview, and the system prompt's mailbox note.
