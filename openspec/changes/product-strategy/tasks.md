# Tasks

## 1. Shared types and data model

- [ ] 1.1 Add `src/shared/productStrategy.ts` with SDK-free types (`ProductStrategy`, `StrategyRevision`, `StrategyDraft`, `StrategyDecision`, `StrategyImpactReview`, claim kinds, template section shape, `Unknown` sentinel) matching design D2; verify typecheck and unit tests cover round-tripping a revision content object and canonical hashing stability across key order.
- [ ] 1.2 Add the `product_strategies`, `strategy_revisions`, `strategy_drafts`, `strategy_evidence`, `strategy_decisions`, `strategy_impact_reviews`, and `strategy_repo_bindings` tables per design D1 beside `team_tasks`; verify migration tests preserve existing sessions/tasks and round-trip strategy references, authors, hashes, and timestamps.
- [ ] 1.3 Document the strategy data model, revision lifecycle, claim kinds, and `Unknown` handling in the How It Works documentation; verify the documented fields match the shared types and table columns.

## 2. Strategy store

- [ ] 2.1 Implement `StrategyStore` (`src/server/strategy/strategyStore.ts`) create/get/list and revision writes with content hashing and immutable approved rows; verify tests cover first record per product, template sections present, hash stability, and refusal to mutate an Approved revision.
- [ ] 2.2 Implement draft save/get/list with `expectedBaseRevision`/`expectedDraftHash` CAS and retained client text on mismatch; verify tests cover two concurrent editors (first wins, second refused with conflicting state), draft survival across store reopen, and material-change impact proposals stored on the draft.
- [ ] 2.3 Implement lifecycle transitions Draft → InReview → Approved → Superseded and explicit Withdrawn, keeping superseded and withdrawn rows readable; verify tests cover supersede-on-new-approval, withdrawn drafts being unrestorable, and history order across reopen.
- [ ] 2.4 Implement evidence rows and the refusal of a validated observation without a source reference, plus `Unknown` passthrough for unknown baselines and targets; verify tests cover each claim kind, the missing-source refusal, and no invented metric being written.

## 3. Strategy service and agent tools

- [ ] 3.1 Add `StrategyService` (`src/server/strategy/StrategyService.ts`) binding agent identity to the calling session and product bindings to the caller's team, with human calls arriving as `{ kind: 'human' }` from the UI connection; verify service tests cover cross-team refusal, missing bindings, and a forged actor kind in tool arguments being ignored.
- [ ] 3.2 Register `strategy_list`, `strategy_get`, `strategy_save_draft`, and `strategy_submit_for_review` on the per-session in-process MCP server beside the task handlers, with no approve/publish/withdraw/delete tool; verify handler and driver tests cover each tool, identity binding, and the absence of any publication tool in the registered surface.
- [ ] 3.3 Extend the agent mailbox/system-prompt note with strategy read/propose rights and the human-only approval rule; verify prompt tests cover a permitted proposer, a caller with no product, and that the note never claims agents can approve.
- [ ] 3.4 Document the agent strategy tool contracts and the authority boundary in the How It Works documentation; verify documented tool names and inputs match the registered handlers.

## 4. Human approval and publication

- [ ] 4.1 Implement human-only approve in `StrategyService`, writing `strategy_decisions` (with `UNIQUE(strategy_id, command_id)`) and updating `current_approved_revision` in one transaction with `strategy_impact_reviews` (same unique constraint), guarded by `expectedRevision`, `contentHash`, and `command_id`; verify tests cover exact revision/hash binding, recorded approval scope and open questions, and earlier revisions remaining readable (S04).
- [ ] 4.2 Implement command-id idempotency backed by the unique constraint: same command id and payload returns the prior result, same command id and different payload is refused, stale expected-revision is refused, and a concurrent-approval race leaves exactly one active approved revision with the loser refused as stale; verify tests cover retry, payload mismatch, stale revision, and the race (S17).
- [ ] 4.3 Refuse every agent path that would approve, publish, withdraw, or delete, and ignore repository or peer documents that assert approval; verify tests cover a missing tool, a forged human actor in arguments, a repo file claiming `approved`, and a peer message claiming approval (S09, S05 refusal). Under the recommended Draft B, a comment states the forged-WS-client vector is explicitly accepted, matching `team-task-*`; if the human picks Draft A instead, add the nonce issue/echo to 4.1 and a test that a bare script speaking `strategy-approve` without the nonce is refused (see design D3b).
- [ ] 4.4 Implement publication isolation: approve/publish creates one impact-review item and nothing else — no Plan, task, mail, tool grant, or interruption — with `UNIQUE(strategy_id, command_id)` on `strategy_impact_reviews` enforcing "once"; verify tests cover a publish creating no work, a retried publish not duplicating the item, and a save/submit never creating an item (S14).
- [ ] 4.5 Document the approval record, CAS/command-id rules, and publication isolation in the How It Works documentation; verify the documentation states that a document claiming approved cannot publish.

## 5. Strategy UI

- [ ] 5.1 Add `src/client/components/chat/ProductStrategyPanel.tsx` and a client strategy store in the ChatView side slot beside Tasks/Mailbox/Debug, scoped by the session's team, leading with purpose, users, outcomes, use cases, trade-offs, and boundaries, with revision/hash/owner/status in detail; verify component tests cover an approved product and a product with no record (capture offered, never a forced wizard).
- [ ] 5.2 Add `StrategyDraftEditor.tsx` with template sections, claim-kind labels, `Unknown` measures, and an impact proposal field for material changes; verify component tests cover labeled hypotheses, a refused validated observation without source, and a material draft retaining its unsaved text after a CAS refusal (S12).
- [ ] 5.3 Add `StrategyRevisionHistory.tsx` and the review view showing findings, contradictions, and what is known / assumed / not decided, plus human Approve (exact diff/hash, scope, open questions), Submit, and Withdraw controls disabled while disconnected; verify component tests cover every control, stale-approval errors shown inline, and superseded/withdrawn revisions staying accessible.
- [ ] 5.4 Document where capture, draft, review, approve, revision history, and evidence appear in the UI; verify documented labels match the rendered components.

## 6. Integration

- [ ] 6.1 Add a headless fixture integration with one product and one agent: the agent reads the empty strategy, saves a material draft with an impact proposal and `Unknown` measures, submits for review, and the human approves the exact revision; verify the test passes, asserts the approved revision/hash, the single impact-review item, the unchanged earlier revisions, and that the agent surface still has no approve tool.
- [ ] 6.2 Walk capture, draft conflict on reload, review, approve, retry-with-same-command-id, and a forged repo approval document against the fixture using repository Playwright; verify DOM state and screenshots, including reconnect restoration of drafts.
- [ ] 6.3 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate product-strategy --strict`, and verify the full suite is green with the strategy integration included.

## Workflow follow-up

- Review and archive `product-strategy`, syncing its capabilities into main specs.
- Wave C: `plan-validation` (alignment reports, `PlanStrategyBinding`) and `strategy-revision-impact` (dispositions on the impact-review item created here).
- Keep feature changes in separate incremental commits and branches; push only when requested.
