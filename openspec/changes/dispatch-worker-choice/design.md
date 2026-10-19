# Design

## Context

See proposal.md (Why). The relevant state on master (after #219, #220, and the landed `providers-and-workers`):

- **Catalog (landed).** Providers own models. Model keys are unique and are the stored profile ids. `provider/model` resolves to a bare key in `groupCatalog.ts`, and `providerOf` names a profile's provider. Codex profiles (`codex-chat-sessions`) derive their provider from the resolved home (`codex-home-<12 hex>`), so a selector can name one.
- **Cooldown (landed).** `LimitEventStore.cooldownFor(profileId, providerId)` gives a model's effective cooldown and the provider's.
- **Usage (landed).** `UsageLimitStore` is keyed by provider (providers-and-workers §5, #241). `ctx.providers` is in the rule contract (§6, #241). Codex reports are cached per home provider id.
- **Candidates and routing.** `buildCandidates` (`src/server/team/routing/candidates.ts`) is pure and already takes hard filters:
  - `excludeProfile` (limit forwards);
  - the provider-cooling exclusion;
  - `allowedProfiles`, plan-execution D15's role filter, read from `team_messages.allowed_profiles` (migration 8). It narrows members (`outside-role`) and spawn slots, and orders spawns by the role's order. Only Kawai sets it (`AssignmentService` refuses other callers). `LimitOutcomes.forward` keeps it, minus the limited profile. The router holds with `retryAt` and an `all-profiles-cooling` diagnosis when the built-in strategy finds only cooling candidates (`router.ts`). The dispatcher wakes at the earliest hold, due time, or cooldown (`dispatcher.ts`).
- **Mail tools.** `send_message` and `schedule_message` share one zod `content` and `recipient` shape (`mailboxTools.ts`), handled by `TeamMailbox.send`. `list_groups` returns only id, label, and description.
- **Assignments.** `AssignmentService.payloadDiff` names the first differing field of a replayed request key. Handoffs reuse it with `handoff_kind`, `result_id`, and `expected_response`.
- **Waiting reasons.** These are typed constraints (`WaitingConstraintKind`, `src/shared/team.ts`) ordered by `waitingReasons.ts`.

## Goals / Non-Goals

**Goals:**
- One stored, validated worker choice per message, which every routing path reads.
- The capacity tool returns exactly the facts routing uses, from the same objects.

**Non-Goals:**
- A worker choice on direct mail, replies, or the human Messages composer.
- Changing groups' `strategy`, `onLimit`, caps, or how usage is gathered.
- A persisted usage history.
- Any agent right to change group files.
- A worker choice on Kawai's plan-execution dispatches. Kawai's instructions and handoffs for a change it executes carry only the role's `allowed_profiles`, never `worker_choice`. Roles alone narrow them (the human's decision on PR #221).
- Reconstructing past routing state. The eligibility check (D10) evaluates whatever state its caller supplies. Building that state for an incident cutoff is `process-observability`'s work.

## Decisions

### D1. Store the selector, resolve at route time
- **Storage.** `team_messages.worker_choice TEXT NULL` holds the canonical selector: a provider id, or `provider/model`. One numbered migration (the next free number at landing) adds it and `team_task_assignments.worker_choice TEXT NULL`. The baseline is never edited.
- **Validation.** It is validated at send against the catalog at the sender's team root and the target group's current workers (see the agent-mailbox spec for the refusals).
- **Resolution.** The dispatcher resolves the selector to the set of the group's model keys on each pass. A group or catalog edit after sending therefore takes effect the way every other group edit does.
- **Canonical form.** A bare model key is stored as `provider/model`, so the stored value never depends on bare-id ambiguity later.
- **Normalization.** A bare id that is a provider is stored as the provider. One that is only a model key is stored as `provider/model`. One that is both a provider and a model of a *different* provider is refused as ambiguous. A one-model provider whose model shares its id is not ambiguous.
- Rejected: resolving to model keys at send. A later group edit would silently strand the mail on a worker the group no longer lists, with no way to tell what was meant.

### D2. The choice narrows the existing role filter
- **Filter.** There is no new candidate field.
  - The dispatcher resolves the choice to model keys (D1).
  - It intersects them with the message's `allowedProfiles`: the role's profiles, or every group worker when the message has none. The role's order is kept.
  - The router's `allowedProfiles` option (`sessionMailbox.ts`) passes the intersection. `buildCandidates` then skips members and spawn slots outside it before rules run, exactly as it does for roles today.
  - `team_messages.allowed_profiles` itself is never rewritten. The role stays Kawai's, and the choice stays the sender's.
- **Exclusion reasons.** A member outside the choice reports `worker-choice` (D5), not `outside-role`. A member outside both reports `outside-role`. The cause reporter (`memberCauses.ts`) tells them apart by testing the role list first.
- **Empty intersection.** Only Kawai sets role lists, and Kawai's dispatches carry no choice (Non-Goals). A message therefore never carries both today. The intersection keeps the two composable. An empty intersection is held with `worker-choice`, like any empty filter.
- **Interaction with the forward exclusion.** Both filters may apply to forwarded mail in principle. D4 drops the choice on forwards, so in practice they never stack.
- **Rule picks.** A rule's pick outside the filtered set is "unknown", which already falls back to the built-in strategy.
- **Cooling choice.** When every allowed candidate is cooling, the existing built-in path yields `hold` with `retryAt` at the earliest cooldown end. The dispatcher already wakes then. No new waiting machinery is needed.
- **Empty filter.** When the filter leaves nothing and no spawn is allowed (cap, occupancy), the router's existing `none`/`hold` diagnosis applies, with D5's constraint added.

### D3. Staffing spawns inside the filter
Spawn slots already follow the router's `allowedProfiles` order, so the intersected list (D2) limits and orders them with no new staffing parameter. Slots outside it are never offered, so the reservation transaction's per-profile cap recount stays as is.

### D4. Forwards and parks
- **Forwards.** `LimitOutcomes.forward` enqueues the new message without `worker_choice`. Its `excluded_profile` governs, together with the role list minus the limited profile, as today (see the agent-mailbox spec). A choice pinned to the limited provider would otherwise keep the work waiting for that provider's reset. That would undo the purpose of forwarding.
- **Parks and resumes.** These are direct mail to the holder, which carries no choice.
- **Release.** This returns the original message to its group queue with its choice intact.

### D5. Waiting reason
A new constraint kind, `worker-choice`, has its `detail` set to the selector and `retryAt` set when the hold is a cooldown. It is ordered among the routing specifics, after the capacity constraints. A chosen worker at its cap still reports the existing `profile-cap` for that worker, plus `worker-choice`.

### D6. `team_capacity` reads the routing objects
- **Tool.** A new tool beside the mailbox tools, in the same identity-bound, card-free set. It builds its answer from the same group catalog, live-member counts (`staffing`'s counting, including pending spawn reservations), `LimitEventStore.cooldownFor`, and provider-keyed usage that the router's context uses. That usage is `providers-and-workers` §5 plus the Codex per-home cache. The tool reads only memory and SQLite: no fetch and no write.
- **Shape.** It reads as a slice of `RouteContext`: groups → workers (model key, provider, cap, live) and providers → { usage, cooldownUntil }.
- **Unknown usage.** Usage the store lacks is `null` (unknown), never zeros.
- **Shared logins.** Each provider carries `sharesLoginWith`: the other listed providers detected as drawing on the same account. Switching between them is therefore never presented as escaping a quota window. This was the human's decision on PR #221.
  - **Detection rule.** Detection covers Claude profiles that authenticate through the CLI's stored login. That means their launch env sets none of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, and leaves `ANTHROPIC_BASE_URL` unset or at Anthropic's API. Two such profiles of different providers share a login when `claudeConfigDir(launch env)` resolves to the same path, because that path holds one `.credentials.json`.
  - Codex profiles on one home are already one provider (`codex-chat-sessions` D4), so they are never flagged.
  - **Unknowns.** Any other profile is never flagged. This covers API keys, tokens, proxies and other base URLs, and launch envs that cannot be resolved. An empty `sharesLoginWith` means sharing was not detected; it does not mean the providers are independent, and the tool description says so.
- Rejected: extending `list_groups`. Its answer is a stable directory; capacity is volatile and larger. Keeping them apart keeps the common call cheap, and keeps the prompt note clear about which call is a live reading.

### D7. Assignment and handoff identity
- **Payload identity.** `payloadDiff` compares `worker_choice` after normalization, so `zai/glm-flash` and the bare `glm-flash` it normalizes to are the same payload.
- **Standing-equivalent check.** The agent-retry check that returns an existing handoff instead of dispatching twice includes the choice.
- **Human path.** `team-task-assign` and `team-task-handoff` carry an optional `worker`. `team-task-preview` computes its effective profile and staffing with the filter applied, and adds a cooling warning (never a refusal).

### D8. Rule contract
`RouteContext.message` and `LimitOutcomeContext.message` gain an optional `worker` (the selector). This is additive, in `src/shared/routing.ts`, so the published `kawai-routing.d.ts` stays compatible.

### D9. Prompt and tool descriptions
- **Mailbox note.** The system prompt's mailbox note names `team_capacity` and the `worker` argument. It states that a choice applies only to group mail, that a cooling choice waits for the cooldown end, and that caps still apply. It also states that providers marked as sharing a login draw on one quota window.
- **Strategy wording.** Nothing in the prompt states a strategy for when to switch providers. That stays the lead's judgment and its group's role text.

### D10. One pure eligibility check
The human decided this on PR #221. `process-observability` D12 must be able to ask, at an incident cutoff, which workers could have taken the work and why each other alternative could not. Reading the last dispatch pass's record is not enough, so eligibility becomes one reusable pure function.
- **Module.** `workerEligibility.ts` in `src/server/team/routing/`, SDK-free, with no I/O and no clock read.
- **Input.** A stated routing state:
  - the group's workers, caps and strategy;
  - the message's worker choice and role list;
  - the members (profile, worktree, busy, pending request, parked, context-exhausted);
  - the effective cooldown per profile;
  - the staffing counts (group, per profile, team spawns, worktree writers, spawn backoff);
  - the evaluation time.
- **Output.** The eligible members and spawn slots in preference order. Every excluded alternative, member or worker slot, comes with its reasons. Each reason is a `WaitingConstraintKind` (`outside-role`, `worker-choice`, `profile-cooling` with its end, the caps, `worktree-occupied`, `spawn-backoff`, and the member causes), with the counts and detail the waiting reasons use.
- **One source.** `buildCandidates` and the cause reporter (`memberCauses.ts`) are rebuilt on it. The dispatcher, the dispatch preview, `team_capacity`'s live counts and D12 therefore cannot disagree about who was eligible.
- **The caller states the state.** For a live pass the dispatcher builds the state from current objects. For a cutoff, D12 builds it from its records, using `coolingTimeline` and the stored events. This change adds no reconstruction and no new table.
- **Rejected:** having D12 read the last pass's diagnosis. A pass records only mail that was waiting at that moment, so an incident with no pass near its cutoff would have no answer.

## Risks / Trade-offs

- [A lead pins work to a provider and forgets it] → The waiting reason names the choice and its retry time. The Mailbox lets the human or a `canManageMailbox` agent cancel the mail, and the lead can re-dispatch.
- [Usage is unknown after a restart until the next report] → The capacity tool states unknown and its source, and the lead's prompt note says so. Kawai never invents a figure.
- [Landing before `providers-and-workers` §5/§6] → Satisfied: that change landed §5/§6 in #241 and was archived (#242). (The ordering mattered: without provider-keyed usage, `team_capacity` would report per-model usage under a provider heading, which misstates shared plans.)
- [Wider tool surface invites over-steering] → The argument is optional, and with no choice routing is unchanged.

## Migration Plan

- **Migration.** One numbered migration adds the two nullable columns. Old rows read as no choice. Rollback is the usual pre-migration backup. An older build refuses a newer database (database safety), so there is no half-downgrade.
- **Rule contract.** The rule field is additive, so existing rules are unaffected.
