# Proposal

## Why

Kawai's planned Plans detail exposes records but does not yet give the human a visual work breakdown, dependency overview, supporting documents, and planning conversation in one place. A Plan workspace lets the human understand parallel execution and shape future work without losing the existing Team Lead conversation.

## What Changes

- Make the repository's Plans tab a dependency-oriented workspace: an expandable work breakdown beside a sequence/parallelism map, a document reader, and an optional conversation panel. Horizontal position represents dependency depth, not dates or estimated duration.
- Read change sections and checklists from OpenSpec artifacts. Assignments stay at change level; checklist counts remain separate from execution stages, review, and landing.
- Show actual change-level assignment holders and waiting reasons. Agent names carry compact green/yellow/red/unknown indicators with inspectable context usage, provider quota, source, freshness, and reset details.
- Render associated proposal, design, specs, tasks, architecture Markdown, and image mockups. Identify the source worktree and distinguish current files from execution-pinned inputs.
- Bind two distinct existing chat sessions to the repository: Architect for exploration/planning and Team Lead for execution coordination. Select the existing coordination chat as Lead; do not create a shadow Lead. Reuse these sessions across plans and allow ordinary session creation when a role has no chat yet.
- Explicitly attach the selected plan and its displayed revision/draft identity to each message sent from the workspace; optional change/document references refine scope. Preserve the attachment in history and deliver it to the agent. Switching plans never silently retargets a composed message.
- Keep planning, approval, and execution controls on their existing service paths. The Architect prepares plans and artifacts using its configured tools; the Lead continues dispatch and coordination under its existing permissions.

Non-goals: calendar scheduling, estimates, date dragging, per-checkbox assignment, in-browser document editing, new dispatch/approval rights, automatic staffing, a new orchestrator, a generic file browser, embedded arbitrary HTML mockups, or changes to execution gates.

## Capabilities

### New Capabilities

- `plan-workspace`: dependency/WBS presentation, document associations and reading, change holders and passive health, repository Architect/Lead chat bindings, explicit per-message plan context, navigation and reconnect behavior.

### Modified Capabilities

None. This adds a cohesive workspace capability while preserving existing chat, navigator, task, quota, and OpenSpec discovery requirements. It enriches the Plans surface introduced by the pending `durable-plans` change rather than replacing its plan record or approval contract.

## Impact

- **Prerequisites:** `team-workspace-pages`, `durable-plans`, and `plan-supervision` (transitively `plan-execution` and its dependencies). Implement against their landed contracts. These changes are currently pending; the Plans route is reserved today. This change does not implement those prerequisites.
- **Client:** mount the Plans workspace in `TeamWorkspaceView`; compose the proposed `TeamPlansView`/`teamPlanStore` with dependency layout, checklist, document and conversation components. Reuse `Markdown`, chat transcript/composer/request controls and session stores. Extend `teamLocation` for addressable plan/revision/change/document selection.
- **Server/shared:** add a team-scoped workspace read model and subscription, bounded document/asset reads and reference metadata, persisted repository conversation bindings, passive health aggregation, and additive chat-send/history context. Extend `src/shared/types.ts`, chat event parsing/replay and `CHAT_CONNECTION_TYPES`.
- **Data:** additive tables for repository chat bindings, supporting document references, and durable per-turn workspace context. Reuse the existing plan, task, assignment, session and usage records; never duplicate their authority.
- **Verification:** focused unit/connection tests and an isolated browser walkthrough, plus the repository lint, typecheck and test commands. Document the workspace behavior in AGENTS.md during implementation.
