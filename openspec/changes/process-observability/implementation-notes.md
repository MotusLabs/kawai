# Implementation notes

## Worktree and baseline

- Branch: `feat/process-observability`.
- Dedicated managed worktree: `/home/coder/.codex/worktrees/f1aa/kawai`.
- Base: fetched `origin/master`, `c6ab189ed6bdedc42c961e6e49c18bfc4e90c768`.
- The approved change artifacts were copied from the original checkout, including CLI-created metadata. No unrelated uncommitted files were copied.
- Schema: spec-driven. Initial progress: 0/42 tasks complete.

## Original prerequisite audit (before approved staging)

Checked the fetched default branch at `c6ab189e` on 2026-10-18. At that initial apply, original task 1.1 remained unchecked because its required landed contracts were not all present. This is historical evidence, not a claim about the current remote head.

| Prerequisite | Observed state | Consequence |
| --- | --- | --- |
| `team-process-metrics` | Archived by `758f116f`; main specs `chat-turn-usage`, `process-reports`, and `team-process-metrics` exist. | The earlier missing-spec prerequisite is satisfied. |
| `providers-and-workers` | 15/30 tracked tasks complete on the base. Catalog/group/UI work exists, but provider cooldown (section 4) and shared provider usage (section 5) remain unchecked. `chat-usage-limits` still specifies per-profile reports. | Shared-account capacity/cooldown contracts required by design D5/D12 are not ready. |
| `dispatch-worker-choice` | No `team_capacity` implementation or worker-selector contract in the fetched default branch. The planning change is untracked in the original checkout. | Actionable alternative selection cannot consume its specified contract yet. |
| `chat-context-exhaustion` | No context-exhausted session flag or canonical recovery episode contract in the fetched default branch. An independent feature worktree exists; it has not landed. | Context incident integration cannot consume its specified contract yet. |
| `plan-execution` | Implemented and archived on the base (`c6ab189e` merges archive PR #211). | Its acceptance/landing integration is available; later optional plan changes retain their own prerequisites. |

No application code or task checkboxes were changed. No other changes were archived, merged, or cherry-picked.

## Approved staging revision

The owner answered “yes, revise” to the explicit proposal to revise task ordering and implement the independent observation/storage/Prometheus foundation while prerequisite integrations remain pending.

- Revised task 1.1 audits/rebases the foundation baseline; the original landed-contract verification is preserved in the new task 3.1.
- Foundation order: groups 1-2, then tasks 9.1-9.5. Provider/dispatch/context integration is not a prerequisite for this milestone.
- Original group-3 tasks move from 3.1-3.4 to 3.2-3.5. Task 9.3 covers the core renderer/sources; full provider quota, canonical stage and incident-family checks remain in new task 9.6. New task 9.5 verifies the usable foundation.
- All final capabilities and acceptance criteria remain required. No task was marked complete for revising the plan: progress is now 0/45 rather than 0/42.
- The shared remote ref inspected during revision now includes context-exhaustion merge `9b3f0e84` (PR #213). This worktree remains on its recorded baseline plus planning commits; the next apply must refresh/rebase and recheck source/spec contracts. No assumption is made that other prerequisites landed with it.
- The revision changes planning and audit documents only. No other change is archived, merged or reimplemented here. Full change completion/archive still requires all pending integrations and final verification.

## Foundation apply baseline

Rebased the dedicated branch onto fetched `origin/master` (`9b3f0e84`, context-exhaustion PR #213). Verified managed chat/task/result/usage stores, schema migrations and archived process-metrics capabilities. Provider usage/cooldown remains profile-scoped and worker-choice/capacity is absent; their checks belong to gate 3.1. Foundation work is authorized independently.

## Foundation delivery (2026-10-18)

Implemented the approved foundation: tasks 1.1–1.5, 2.1–2.4 and 9.1–9.5.
This is a milestone within the change, not completion or an archive.

- Migration 11 (`process-observations`) adds observation details, access associations, retained source identities/checkpoints, live interval state and durable export aliases/totals. The frozen baseline and earlier DDL were not edited. The test DB helper now uses the production versioned runner, so reopening cannot reapply migration 11.
- Migration 14 (`process-observation-indexes`) indexes `chat_turn_usage.ended_at` and `profile_limit_events.at` for the reconciler's NOT EXISTS scans; post-commit notifications coalesce into one pass 250 ms after the first.
- Post-commit reconciliation records managed task/result/assignment/finding/mail/limit/usage facts, keeps handoff/result/revision references, and protects acceptance and mailbox settlement from collection failures. First acceptance has a retained per-task identity; accepting again or reopening cannot recount it. Landing classification requires the system actor and the exact result/commit.
- Managed timing preserves task/start pins, independent tool/request/activity intervals, approval-wait subtraction, overlapping tool union versus summed work, and checkpointed restart uncertainty. Background-task level updates do not extend active work.
- Live turn IDs are now UUIDs: the old per-driver `turn-1` counter could collide after restart in usage and interval keys. The walkthrough now resumes the SDK conversation and completes a third turn after a manager restart, verifying three distinct usage/completion records and one acceptance. Already-lost legacy usage and legacy zero-versus-missing ambiguity cannot be reconstructed.
- Structured context samples coalesce ordinary updates while preserving exact lifecycle/threshold/compaction boundaries, approximation and known threshold provenance. Missing compaction post size/duration, final usage, provider/account identity and unavailable settings versions remain unknown.
- Fact observations and completed usage retain 90 days, intra-turn interval detail (activity, tool, request, context, turn start/attribution) 14 days, with bounded pruning and backlog continuation; the detail horizon checkpoint states the 14-day cutoff and `facts-retained-since` the 90-day one; source keys, totals, aliases and immutable existing reports persist. Tests cover 75-day usage and explicitly partial earlier coverage.
- Optional same-listener bearer-authenticated `/metrics` has a fixed bounded registry, persistent counters/classic histograms, conservative alias/expanded-series budgets, a consistent five-second snapshot, capability/coverage diagnostics and no model/network scrape work. Disabled or invalid configuration leaves normal operation intact. Provider-account quota, canonical stage and canonical incident samples are absent rather than fabricated.
- Operator definitions, scope, buckets, retention, recovery, legacy limitations and configuration are in `docs/operations/process-observability.md`; recovery mechanisms are also recorded in `docs/recovery-matrix.md`.

### Verification

- The implementation commit passed the repository pre-commit `bun run lint`, `bun run typecheck` and `bun run test`: **5,453 passing tests, zero failures** (5,001 main-suite tests plus isolated suites). Lint has five existing warnings and no errors.
- Strict `openspec validate process-observability --strict` passed.
- After that full run, refreshed/rebased onto `origin/master` **23bbfd44**, including session-targeted task handoffs (PRs #215/#216) and team-role updates. No foundation code conflict occurred. On the rebased branch, lint/typecheck passed again; **55** foundation/schema/recovery/handoff tests and **3** managed-manager walkthrough/timing/poll-stop tests passed. The full-suite count above describes the implementation before this final upstream rebase; the additional targeted checks describe compatibility with the rebased upstream handoff changes.
- The isolated manager walkthrough and endpoint tests use scripted SDK frames and local SQLite/Hono instances. They make no model-provider requests, deploy nothing, and require no Prometheus installation. No browser UI was changed; the full recommendation/daily-reassessment browser walkthrough remains in task 10.3/10.4.

### Integration gate 3.1

Rechecked the actual fetched default branch at **23bbfd44**. Context-exhaustion and session-targeted task handoffs are landed, but provider cooldown/usage tasks 4.x/5.x in `providers-and-workers` remain unchecked, `chat-usage-limits` still specifies per-profile reports, and the `team_capacity`/worker-choice contract is absent. These are actual missing interfaces, not fixtures or partial task counts used as proof of readiness.

Task 3.1 and the remaining integration/recommendation/digest/experiment tasks remain unchecked (31 tasks). No upstream feature was stubbed, merged or archived to satisfy this gate. Migration 11 is free on this base; `providers-and-workers` explicitly takes the next free version at landing, so its migration must be reconciled with this registry when either branch lands first.
