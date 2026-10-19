# Tasks

`providers-and-workers` §5/§6 landed in #241 and the change is archived (#242). Rebase onto current master and confirm `cooldownFor`, the provider-keyed `UsageLimitStore`, and `ctx.providers` exist (they do on master at a28d464a).

## 1. Selector and storage

- [ ] 1.1 Add the next numbered migration (the next free number at landing), adding `team_messages.worker_choice` and `team_task_assignments.worker_choice` (nullable). Verify that `schemaBaselinePin.test.ts` gains its expected delta, and that migration tests pass on a copy of a database at the previous version.
- [ ] 1.2 Add a pure worker-selector module: parse and normalize against the catalog (provider; `provider/model`; bare model key → `provider/model`; refusing an ambiguous bare id; one-model provider not ambiguous) and resolve a selector to a group's model keys. Verify with unit tests covering every case in design D1 and the agent-mailbox spec's refusals.
- [ ] 1.3 Thread `workerChoice` through `MailboxStore.enqueue`, `TeamMessage`, and the assignment store rows. Verify round-trip store tests, and that a `null` choice reads exactly as today.

## 2. Routing and staffing

- [ ] 2.0 Add the pure eligibility check `workerEligibility.ts` (design D10). It takes a stated routing state and returns the eligible candidates in preference order, plus every excluded alternative with its constraint kinds. It does no I/O and reads no clock. Then rebuild `buildCandidates` and `memberCauses.ts` on it. Verify with unit tests:
  - each exclusion reason;
  - an evaluation at a past time with the cooldowns then in force;
  - existing candidates, router and waiting-reasons suites pass unchanged, with the same answers as before;
  - a structural test that the module imports no store, filesystem or clock.
- [ ] 2.1 Resolve the selector on each pass, and intersect it with the message's role list in the router's `allowedProfiles` option (`sessionMailbox.ts`), keeping the role's order. Report `worker-choice` versus `outside-role` per member through the eligibility check, testing the role first. Verify candidates and router tests:
  - members on other workers are skipped;
  - spawn slots are limited and ordered;
  - an unset choice changes nothing;
  - a choice with a role list keeps only the intersection, with each member's cause.
- [ ] 2.2 Wire the intersection through the dispatcher's pass. Verify a dispatcher test where a chosen provider's member is picked over a longer-idle member elsewhere, and a staffing test where a capped chosen worker waits instead of spawning on another worker.
- [ ] 2.3 Treat a rule pick outside the filtered set as unknown. Verify a router test with a rule naming a filtered-out candidate falling back to the built-in pick.
- [ ] 2.4 Add the `worker-choice` waiting constraint (detail selector, `retryAt` on cooldown) and its ordering. Verify `waitingReasons` tests for a cooling hold (retry at the cooldown end) and a cap hold (`profile-cap` plus `worker-choice`), and a dispatcher test where the message routes at the cooldown end without any other change.
- [ ] 2.5 Make `LimitOutcomes.forward` drop the choice. Verify a limit-outcome test where a forwarded message has no choice and still excludes the limited worker, while a released message keeps its choice.
- [ ] 2.6 Add the optional `worker` to `RouteContext.message` and `LimitOutcomeContext.message` in `src/shared/routing.ts`. Verify a rule-host test where a rule sees it, and that the published `kawai-routing.d.ts` copy matches.
- [ ] 2.7 Document the choice in `docs/routing/README.md` (filter, holds, forwards). Verify the README examples match the rule types.

## 3. Agent tools

- [ ] 3.1 Add `worker` to the `send_message` and `schedule_message` schemas only (not the shared `content` spread, which `reply` also uses), with descriptions, validated in `TeamMailbox.send` with the spec's refusals, nothing queued on refusal. Verify mailbox tool tests: group accept, refusals for direct mail, the human, an unknown worker, a worker outside the group, an ambiguous id, and a `worker` given on `reply`.
- [ ] 3.2 Add `worker` to `task_handoff` and include it in `payloadDiff` and the standing-equivalent check. Verify task tool tests: a group handoff carries it; the same key with a different worker is refused naming `worker`; a session target refuses it. Verify that Kawai's plan-execution dispatches and handoffs (`executionDispatch.ts`, `executionLanding.ts`) never set `worker_choice`, with an execution test asserting a null choice beside the role's allowed profiles.
- [ ] 3.3 Implement `team_capacity { group? }` from the routing objects (design D6), card-free and identity-bound. Verify tool tests: every group, one group, an unknown group refused, unknown usage as null, a cooling provider's end, and live counts including pending spawns equal to what `buildCandidates` counts.
- [ ] 3.3a Add `sharesLoginWith` to `team_capacity`, following design D6's detection rule. Verify unit tests:
  - two stored-login Claude profiles with one config directory are marked as sharing, both ways;
  - different config directories are not marked;
  - profiles using an API key, an auth token, an OAuth token or a proxy base URL are never marked;
  - Codex profiles on one home are never marked;
  - the tool description states that unmarked means not detected.
- [ ] 3.4 Update the system prompt's mailbox note (`teamPrompt.ts`) to name `team_capacity` and `worker`. Verify the prompt snapshot test.

## 4. Human dispatch

- [ ] 4.1 Carry an optional `worker` on `team-task-assign`, `team-task-create` (with assignment), and the human handoff, through `AssignmentService`. Verify service tests for storage, instruction mail carrying the choice, and the replay refusal naming `worker`.
- [ ] 4.2 Apply the choice in `team-task-preview` (effective profile, staffing, cooling warning). Verify preview tests including a cooling warning that does not block.
- [ ] 4.3 Add the worker picker to the task form and the Assign dialog: group targets only, workers grouped by provider with usage and cooldown, and the choice inside the armed request key's payload. Verify client tests, and a `dev-browser` walkthrough assigning on a chosen provider.
- [ ] 4.4 Add the worker choice bullet to AGENTS.md (mail, routing, capacity tool, human dispatch). Verify that the doc names only shipped tool and field names.

## 5. Integration

- [ ] 5.1 End-to-end check on the development fixture or a test team: the lead reads `team_capacity`, dispatches group task mail with `worker` to another provider, a member spawns on it in the task's worktree, and the Mailbox shows the choice while it waits on a cooling provider. Verify by recorded screenshots or the test log, and that `bun run lint && bun run typecheck && bun run test` pass.

## Workflow follow-up

- `providers-and-workers` is archived (#242), so these deltas apply to the main specs; archive after review.
