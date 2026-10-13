# Proposal

## Why

Kawai can record tasks and mail, but nothing durable says *whom the product serves, which problems matter, or which trade-offs guide the work*. Every Plan and task restates direction from scratch, and agents fill the gap by inventing motives, metrics, and priorities. `docs/product-strategy.md` recommends a human-approved **Product Strategy** above Plans. This change delivers Strategy steps 1–2 of that sequence: a strategy record with a draft/version lifecycle and exact human approval. Plan alignment (step 3) is a separate change.

## What Changes

- **Strategy record.** One `ProductStrategy` per product with a human owner, lifecycle, repository bindings, and a current approved revision, plus numbered `StrategyRevision`s (Draft → InReview → Approved → Superseded, plus explicit Withdrawn). Approved content is immutable; a draft cannot replace the active approved revision; superseded revisions stay accessible.
- **Default strategy template.** Purpose, Primary users, Needs/outcomes, Main use cases, Product approach, Principles and trade-offs, Boundaries/non-goals, Success measures, Assumptions and evidence, Open questions, Decisions and revision history. Missing baselines/targets are `Unknown`, never invented.
- **Evidence and assumption labeling.** Claims carry a kind (owner preference, explicit user statement, agent interpretation, proposed choice, hypothesis, validated observation), a source, and limitations. A validated observation without a source is refused.
- **Durable drafts.** Agent and human drafts are stored server-side and survive navigation, reconnect, and reload. Concurrent edits refuse overwrite with expected-revision (CAS) checks and leave the client's unsaved text intact for resolution.
- **Human-only approval at runtime.** Approval is a `StrategyDecision` record binding an exact revision/hash and a human owner, written only by the human UI action path. Agents can read the strategy and propose drafts; they have no tool that approves or publishes. A repository or peer document claiming "approved" is untrusted content and cannot grant publication (S09). Stable command IDs make approval and publication idempotent (S17). The guarantee is that no agent tool surface can approve — the transport below the UI connection is the same boundary every existing human WS action has (see design D3b).
- **Publication isolation.** Saving a draft, submitting for review, and publishing grant no Plan, no dispatch, and no tools. Publication requires human approval and creates its impact-review item exactly once (the item is a stub here; reviewing live Plans is Wave C).
- **Strategy UI** at product/repository scope: capture/draft, review, approve (exact diff/hash, scope, open questions), revision history, and evidence — reachable from the chat's side slot beside Tasks/Mailbox/Debug, scoped by the session's team.
- **Agent tools.** `strategy_list`, `strategy_get`, `strategy_save_draft`, `strategy_submit_for_review` on the per-session in-process MCP server. No approve, publish, or withdraw tool exists.

Non-goals: Plan alignment reports and `PlanStrategyBinding` enforcement (step 3 / `plan-validation`); revision-impact review of live Plans beyond creating the one impact-review item (step 4 / `strategy-revision-impact`); evidence-driven learning from completed Plans (step 5); the proposed Strategy Discovery/Synthesis/Review/Plan Alignment/Revision Impact skill packages (contracts in the doc, **not** installed capabilities); establishing any approved Kawai strategy; execution permissions or tool grants; multi-product cross-repository access scopes beyond identity.

**Human flag:** the doc's Example A ("Kawai: supervised autonomous software development") is a hypothetical draft. It MUST NOT be installed as Kawai's approved strategy, seeded as a default, or treated as existing direction. This change ships no approved strategy at all.

## Capabilities

### New Capabilities

- `product-strategy`: strategy records, revision lifecycle, the default template and evidence/assumption labeling, durable drafts with CAS, agent read/propose, the no-strategy case, and the strategy UI.
- `strategy-approval`: human-only runtime approval and publication — the approval record, exact revision/hash binding, command-ID idempotency, immutability and supersession, refusal of forged or unauthorized publication, and publication isolation.

### Modified Capabilities

None. `team-tasks` is unchanged: standalone tasks stay permitted with no strategy binding created.

## Impact

- Server (new): `src/server/strategy/` — `strategyStore.ts` (`StrategyStore`: `product_strategies`, `strategy_revisions`, `strategy_drafts`, `strategy_evidence`, `strategy_decisions`, `strategy_impact_reviews` in the same SQLite database `TaskStore` uses), `StrategyService.ts` (`StrategyService`: identity-bound draft/submit, human-bound approve), `strategyTools.ts` (`strategyHandlers`, schemas), `strategyConnections.ts` (`StrategyConnections`: subscriptions and human actions).
- Shared (new): `src/shared/productStrategy.ts` — SDK-free types (`ProductStrategy`, `StrategyRevision`, `StrategyDraft`, `StrategyDecision`, claim kinds, template section shape), mirroring `src/shared/teamTasks.ts`.
- Shared (modified): `src/shared/types.ts` — `ServerMessage` gains `strategy-snapshot`, `strategy-detail`, `strategy-result`; `ClientMessage` gains `strategy-open`/`close`, `strategy-save-draft`, `strategy-submit`, `strategy-approve`, `strategy-withdraw`.
- Server (modified): `src/server/chat/ChatSessionManager.ts` (construct the service and connections beside `this.tasks`, register strategy tools on the per-session MCP server created in `createMailboxServer`), `src/server/team/taskTools.ts` / mailbox server setup (register `strategy_*` handlers with the same session-identity binding as `taskHandlers`).
- Client (new): `src/client/components/chat/ProductStrategyPanel.tsx`, `StrategyRevisionHistory.tsx`, `StrategyDraftEditor.tsx`; client store beside `chatStore`/task views. (Modified): `src/client/components/chat/ChatView.tsx` side slot (pattern of `TeamTasksPanel`), `src/client/components/chat/TeamTaskDetail.tsx` untouched.
- Tests: store/service/connection/component coverage in the existing `bun run test` suites; fixtures follow the `team-tasks` temporary-repository pattern with `cleanGitEnv()` for any git command.
- Cost/risk: none to execution — strategy state never grants tools, dispatch, or Plan creation. The only write path that changes "what is true" is human approval through the human UI action path.
