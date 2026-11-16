# Proposal

## Why

Current agent task reads still expand full child instructions, all results and assignment/publication/acknowledgement histories; large bodies can consume context before the agent sees the evidence it needs. Revision reads already landed in PR #396, making a fresh task-only slice possible without adopting the held metrics implementation.

## What Changes

- **BREAKING, proposed for owner review:** compact child rows; byte previews for message bodies and historical result summaries; outstanding result plus 50 historical rows, selected whole result via `result_id`, and 8,192-byte diff previews with a lossless `task_result_diff_read` tool.
- Add child/message/result anchors and explicit `full_messages` (potentially large). Bound assignment/publication/acknowledgement windows at 50; omit repeated assignment instructions and preview publication rationales.
- Propose additional history anchors for assignments, publications and acknowledgements so truncation is recoverable; these are explicit refinements of legacy 3.5, not an already approved API.
- Preserve current task identity, current instruction, result revision pins, blind-first sealing, journal/revision/list behavior, and human detail. Update tool/prompt/header guidance and regression tests.

## Capabilities

### New Capabilities

None: the diff reader belongs to the existing task-record capability.

### Modified Capabilities

- `team-tasks`: bounded task agent detail, explicit whole-read routes, history windows and their guidance.

## Impact

See design for pinned source inventory and concrete paths. Future changes affect task read projections, types, tool registration and prompts; no stored record migration is planned. No client payload or UI change is proposed.

This is a PROPOSED slice of still-missing legacy `bounded-metrics-and-task-get` tasks 3.1, 3.2/3.2a, 3.4/3.4a, 3.5 and remaining 3.6. Legacy 3.3 and its revision guidance are preserved baseline. Legacy artifacts, checkboxes, held tasks/branches and evidence remain untouched; this proposal neither supersedes nor approves/cancels that parent. The owner later decides the legacy reconciliation before execution registration. Metrics/report/drill APIs, including the landed PR #405 `detail: compact|full` contract, are excluded.

Evidence at `714cf8da`: `taskJournalWindow.ts` caps journal/children/messages and revisions but loads full child summaries, messages and all results/history. `mailboxTools.ts` serializes handler results as one JSON string. The legacy proposal's 2026-11-03 task figures (1.01 MB umbrella, 412 KB smaller task) are historical attributed measurements, not current sizes or latency. Current latency and serialized size are Unknown; this planning task does not sample live data. Future deterministic fixtures measure bytes and bounded query behavior without inventing wall-clock targets.

Owner-review archive constraint: both this delta and the legacy change MODIFY the same task_get bounds and guidance requirements, while PR #396 revision-row/whole-revision definitions remain only in the legacy delta. Before either sync/archive, the owner must choose a separate reconciliation/archive order that gives those landed definitions a main-spec home and re-derives the overlapping legacy MODIFIED blocks. Archiving this slice alone is not yet authorized; no legacy edits or revision reimplementation occur here.
