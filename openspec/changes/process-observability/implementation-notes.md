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
