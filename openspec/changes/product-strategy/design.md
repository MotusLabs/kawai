# Design

## Context

Team state is already kawai-owned and SQLite-backed: `TaskStore` (`src/server/team/taskStore.ts`) creates `team_tasks`, `team_task_revisions`, and `team_task_journal` in the server database and is policy-free; `TaskService` (`src/server/team/TaskService.ts`) binds identity to the calling session and decides who may do what; human actions arrive over the chat WebSocket and are scoped by the session's resolved team (`src/server/team/taskConnections.ts`, `src/shared/types.ts` `ClientMessage`/`ServerMessage`) and agent tools ride the per-session in-process MCP server (`src/server/team/taskTools.ts`, registered in `ChatSessionManager` via `createMailboxServer`). This change follows that pattern, including its transport boundary (see D3).

Nothing in the repository is authority for direction today. `docs/product-strategy.md` is a recommendation and its Example A is a hypothetical draft — the design must not seed it. Product Strategy sits above Plans in `docs/multi-agent-development-ux.md` §1, but Plans themselves are not in this change.

## Goals / Non-Goals

**Goals:**
- One durable strategy record per product with immutable approved revisions and durable drafts.
- Approval as a runtime record only a human can create, bound to an exact revision/hash, CAS-guarded and idempotent.
- Agent read/propose without any approve/publish capability in the tool surface.
- Publication that creates one impact-review item and nothing else.

**Non-Goals:**
- Plan alignment reports, `PlanStrategyBinding`, or Plan validation gates (`plan-validation`).
- Reviewing live Plans for revision impact, beyond creating the impact-review item once (`strategy-revision-impact`).
- The proposed skill packages (Strategy Discovery/Synthesis/Review/Plan Alignment/Revision Impact) — contracts in the doc, not shipped capabilities.
- Installing any approved Kawai strategy, including Example A.
- Execution permissions, tool grants, or multi-product cross-repository access scopes beyond identity fields.

## Decisions

### D1. Strategy state is SQLite-owned by kawai, never file-backed
Tables beside `team_tasks` in the same database: `product_strategies(id, product_id, title, owner_kind, owner_session, lifecycle, current_approved_revision, created_at, updated_at)`, `strategy_revisions(strategy_id, revision, status, content_json, content_hash, author_kind, author_session, impact_proposal, created_at)`, `strategy_drafts(strategy_id, draft_id, base_revision, author_kind, author_session, content_json, content_hash, updated_at)`, `strategy_evidence(id, strategy_id, revision, claim_ref, kind, source_ref, observed_at, limitations, access_scope)`, `strategy_decisions(id, strategy_id, revision, content_hash, decision, rationale, actor_kind, actor_session, approval_scope, open_questions, command_id, created_at)` with `UNIQUE(strategy_id, command_id)`, `strategy_impact_reviews(id, strategy_id, revision, content_hash, command_id, state, created_at)` with `UNIQUE(strategy_id, command_id)`. The store is policy-free; `StrategyService` enforces rights before writing.

The two `UNIQUE(strategy_id, command_id)` constraints are what make D4's idempotency a database fact rather than a check-then-write race: a retried approve cannot insert a second `strategy_decisions` row, and S14's "impact-review item once" is enforced by the same constraint on `strategy_impact_reviews`. Scope is per product, so a client can use deterministic command ids without colliding across products.

*Alternative:* approved strategy as markdown in the repo — rejected: agents can write files, so S09 (forged approval) would be unenforceable and a checkout could rewrite history; concurrent worktrees conflict; a merge is not an approval. A read-only export can be added later as a projection, never as authority.

### D2. Revision content is structured, hashed canonically
`content_json` holds the template sections plus structured lists (use cases, success measures, claims, open questions, decision history). `content_hash` is SHA-256 of the canonical serialization (stable key order, `Unknown` preserved as a sentinel). Approval and CAS compare hashes, so reordering or cosmetic drift is visible. Prose lives inside section fields; the UI renders the template from the structure.

*Alternative:* freeform markdown — rejected: claim labels and `Unknown` handling would rely on conventions the runtime cannot check (S08).

### D3. Approval is a runtime record only the human UI action path can create
`strategy_decisions` is written only from `StrategyConnections` human actions (`strategy-approve`, `strategy-withdraw`), with actor `{ kind: 'human' }`. The active approved revision is `product_strategies.current_approved_revision`, updated in the same transaction as the decision and the `strategy_impact_reviews` row. Agents' `kawai-team` tools (`strategy_list`, `strategy_get`, `strategy_save_draft`, `strategy_submit_for_review`) have no approve/publish/withdraw handler at all. Repository and peer content are never parsed for approval state.

**What this does and does not establish.** It establishes that the decision did not come from the agent tool surface and that no repository or peer document can grant publication (S09's named vectors). It does **not** establish that a human physically typed the frame: `/ws` upgrades unconditionally (`src/server/index.ts`) and human actions are trusted from the message's `sessionId`, exactly as `TaskService` does for `team-task-create`/`amend`/`status`. A local process that can open the WebSocket can speak `strategy-approve`. That is the same boundary every existing human WS action already has; see the two drafts below and Open Questions.

### D3b. Human assurance for approval — two drafts (human chooses)
The review found that "authenticated human UI connection" overclaims. Both drafts below are written out; the spec files carry Draft B until the human rules.

**Draft B — honest boundary (recommended, currently in `specs/strategy-approval/spec.md`).**
Requirement text: "Approval, publication, and withdrawal SHALL be possible only through the human UI action path. Agents SHALL have no tool that approves, publishes, or withdraws a revision. The runtime SHALL enforce this; prompt conventions are insufficient. The guarantee is that no agent tool surface can approve; it does not by itself distinguish a human browser from a local process speaking the UI connection protocol."
Task delta: 4.3 notes that the forged-WS-client vector is explicitly accepted, matching `team-task-*`.
Why recommended: an assurance step applied only to `strategy-approve` would harden strategy approval while leaving `team-task-create`/`amend`/`status` equally forgeable — that looks secured and is worse than an honest boundary. The real fix is a separate change covering every human WS action.

**Draft A — real assurance step (alternative).**
Requirement text: "Approval, publication, and withdrawal SHALL be possible only through the human UI action path after a server-issued human-assurance step: the server issues a nonce bound to the live UI connection and the action must echo it. Agents SHALL have no tool that approves, publishes, or withdraws a revision. A client that cannot complete the assurance step SHALL be refused. The runtime SHALL enforce this; prompt conventions are insufficient."
Mechanics: `StrategyConnections` issues the nonce only to a connection that has opened a strategy view (the browser flow) and echoes it in `strategy-approve`; the nonce is single-use, bound to the connection, and expires. A bare script that speaks the frames without it is refused.
Task delta: 4.3 gains a forged-WS-client case (a script that speaks `strategy-approve` without the nonce is refused); 4.1 gains the nonce issue/echo step.
Limitation to state even under A: it does not close the same hole on `team-task-*`, so it needs a companion change there to be worth having.

### D4. CAS and command IDs
Every draft save takes `expectedBaseRevision` + `expectedDraftHash`; mismatch refuses the write and returns the stored draft so the client can keep its unsaved text (S12). Every approve/withdraw takes `expectedRevision` + `contentHash` + `commandId`. `strategy_decisions.command_id` is unique per product: a repeat with the same payload returns the stored result; a repeat with a different payload is refused; a stale expected-revision is refused (S17). Approval transaction guards `current_approved_revision` with its prior value so two racing approvals cannot both land.

### D5. Product identity starts as the owning team
A strategy's `product_id` is a human-chosen slug created with the record; its repository bindings start as the owning team (git common dir, `teamIdentity`) plus that team's listed worktrees. Binding rows live beside the strategy (`strategy_repo_bindings`) so a later product registry can widen them without a schema break. Cross-repository and multi-product-per-repo bindings are out of scope except as these fields.

*Alternative:* a full product registry with cross-repo scopes now — rejected: it would need access-scope policy that this change deliberately excludes.

### D6. Publication isolation and the impact-review item
Approving/publishing writes `strategy_impact_reviews` in the same transaction (state `pending`, keyed by `command_id`) and nothing else. No Plan, task, mail, tool grant, or watcher interruption is created. Wave C (`strategy-revision-impact`) will attach Plan dispositions to that item; this change only creates it once and shows it. There is no outbox dispatch to agents — the UI learns of it from the authoritative snapshot, so a crash between persistence and push only delays display.

### D7. Human owner is a single actor
The owner field records the human. Approval is one human owner acting through the UI action path; no quorum or delegation is implemented. Agents can set themselves as draft author only. The system prompt and tool descriptions state that approval is human-only, but the enforcement is the absence of any agent approve path (D3), not the prompt.

### D8. UI sits in the chat side slot, scoped by team
`ProductStrategyPanel` reuses the Tasks/Mailbox/Debug side slot in `src/client/components/chat/ChatView.tsx`, scoped by the session's team like `TeamTasksPanel`. It leads with direction (purpose, users, outcomes, use cases, trade-offs, boundaries) and keeps revision/hash/owner/status in detail. The multi-agent doc's repository-level Team home will host the same panel later; this change does not build that home.

## Risks / Trade-offs

- [Structured content feels heavy for prose authors] → section fields accept markdown; the structure only pins labels, measures, and hash stability.
- [Single-human approval is a bottleneck] → deferred quorum is a data change on `strategy_decisions`, not a redesign.
- [Product bindings are narrow (one team)] → widening is additive rows; no spec text claims cross-repo reach today.
- [Impact-review item has no consumer until Wave C] → it is visible in the strategy view as pending, so publication never looks like a no-op.
- [Hash canonicalization drift across versions] → one canonical serializer with golden tests; hash is stored, so old revisions stay verifiable.

## Migration Plan

Additive tables only. No existing team, task, or session behavior changes. No strategy is seeded; a product with no record shows the capture affordance. Rollback is dropping the new tables.

## Open Questions

Each has a recommended default the tasks assume unless the human says otherwise; overriding the first three would reshape D1/D5/D7 and the task list.

| Question | Recommended default | If changed |
| --- | --- | --- |
| Product identity and repository bindings | One product per owning team (git common dir + its worktrees); human-chosen slug; no cross-repo bindings yet | Needs an access-scope model and binding validation in D5 |
| Where approved revisions are stored | kawai-owned SQLite (`agentboard.db`) only; repo export later as a non-authoritative projection | File-backed authority would reopen S09; would need signing or a trusted writer |
| Ownership and quorum for approval | Single human owner; no quorum or delegation | Needs multiple actor identities on `strategy_decisions` and a quorum rule |
| Vision vs. strategy as separate records | One record; the template's Purpose/Approach cover both | Splitting adds a second entity and a link |
| Competing drafts | Several drafts per product, one active approved revision; the human picks on approve | Auto-merge or "latest draft wins" would break S12/S17 |
| Evidence threshold for "validated" | Requires a source reference; external research is the author's job | A research gate would need an evidence workflow |
| Review horizon | Storeable field on the record; expiry only prompts review, never approves | Auto-renewal would violate human-only approval |

### Raised in review (2026-10-12): S09 transport assurance

The seven rows above go to the human unchanged. One further question came out of review and needs the same ruling.

| Question | Recommended default | If changed |
| --- | --- | --- |
| Does "human-only approval" require a transport-level assurance step, or is "no agent tool surface" the honest boundary? | **Draft B** (honest boundary): state the guarantee as "no agent tool surface can approve", and accept the local-process WS vector as the same boundary `team-task-*` already has | **Draft A**: add a server-issued, connection-bound single-use nonce that `strategy-approve` must echo, and a forged-WS-client test in 4.3. Doing A only for strategy looks secured while leaving `team-task-create`/`amend`/`status` forgeable — so A should be paired with a separate change covering every human WS action. Both drafts are written out in D3b |
