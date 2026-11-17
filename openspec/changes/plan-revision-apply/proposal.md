# Proposal

## Why

The owner can hold and pause a running plan execution (revision-control, landed), but still cannot move it onto a newer approved plan revision. Approval changes nothing in a running execution, so a forward fix (plan-supervision S4) or a corrected direction joins only a later execution, after Stop throws away unlanded work. Apply was designed inside `revision-control` (its D10–D12, tasks 5.x) and never implemented: `src/server/plans/revisionControl/revisionDelta.ts` exists with no production caller, and no Apply service, message, or dialog exists. This change splits Apply out of revision-control (proposed 2026-11-18) so it can be planned, reviewed, and landed on its own.

## What Changes

- **Apply an approved plan revision to a running execution.** An owner command under a command id, compare-and-swapped on the execution's current revision:
  - Kawai classifies every change against the execution's revision: unchanged, changed (with its differing fields), metadata, added, or removed.
  - For each changed change with a task, the owner picks continue, adapt, or restart. Adapt publishes a task revision with notify.
  - Added changes are scheduled by their dependencies. Removed changes that have not landed are cancelled, with their Kawai-owned tasks.
  - It refuses a landed change whose definition changed or that was removed, a change of landing mode or integration branch, and a change of plan-wide acceptance rules or extra checks once a change has landed. Each refusal points to a forward fix.
  - The target revision needs current validation standing and Start's preconditions for the changes it adds.
  - One transaction records the execution's next revision row, a publication row per change, the task revisions Adapt published with their notices, the cancellations, and a `revision-applied` plan event. A retry under the same command id replays and publishes nothing twice (multi-agent test R17).
- **Preview.** A read-only preview lists the delta, the choices needed, the generated Adapt texts, and the precondition standing.
- **History.** `team-plan-detail` and `plan_get` list each execution's revisions with their publication rows. Attempt manifests keep the revision current at their dispatch, and completion reads the execution's current revision.
- **View.** `PlanApplyRevisionDialog.tsx` from the execution section, and a fixture browser walkthrough that applies a revision with one adapted change.
- No agent tool applies a revision.

## Capabilities

### New Capabilities

- `plan-revision-apply`: the Apply command and its preconditions, the revision delta and per-change choices, added and removed changes, the landed-change refusals, the atomic publication, and the execution revision history. Moved unchanged from revision-control's delta.

### Modified Capabilities

- `plan-execution`: "A running execution keeps its revision" now allows the owner's Apply, forward only. Approval alone still changes nothing. Moved unchanged from revision-control; it now modifies the archived main spec's requirement directly.

## Impact

- **Server.** New modules under `src/server/plans/revisionControl/`: `applyService.ts` (preview and apply), `applyPreconditions.ts` (`APPLY_PRECONDITIONS`), `applyWrites.ts` (the per-change writes inside the transaction), and `applyConnections.ts` (the two messages). Composed in `planComposition.ts`. Readers of the execution's revision in `src/server/plans/execution/` are checked to read the stored row. `ExecutionService.ts` (479 lines) and `executor.ts` (499 lines) are at the 500-line bound, so Apply adds no logic to them.
- **Shared.** Two messages in `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES`; preview and history view types in `src/shared/planRevisionControl.ts`.
- **Client.** `PlanApplyRevisionDialog.tsx`, a `teamPlanStore` command slot, and the history in `PlanExecutionSection.tsx`.
- **Data.** None: migration 17 (revision-control) already created `plan_execution_revisions` and `plan_execution_publication_changes`, and Start writes seq 1.
- **Docs.** The AGENTS.md Apply bullet, the plans architecture bullet, and a recovery-matrix row for Apply's replay keys.
- **Tests.** Table-driven precondition, delta, choice, and crash tables; seeded properties and a model-based crash test; one production-composition test; a fixture-gated browser spec `tests/e2e/chat-plan-revision-apply.spec.ts`.
- **Order.** Builds on revision-control's landed groups 1–4. It shares protocol, detail, store, and view files with revision-control's remaining slice, so the proposed graph orders them by shared path: the blind reading and preview service (1.1, 2.1) run any time; the first production path (2.2, with its message, whitelist entry, and detail rows), the remaining server tasks, and 3.1 after revision-control 9.1–9.2; the client work (3.2–3.3) after revision-control 9.4–9.5.
