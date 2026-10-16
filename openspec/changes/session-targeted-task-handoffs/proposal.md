# Proposal

## Why

The Lead selects a reviewer session to preserve cross-model review, but the
agent's `task_handoff` tool accepts only a group. This forces direct-message
workarounds that lose the handoff assignment and its findings linkage even
though the assignment service already supports session targets.

## What Changes

- Add optional `target_kind: group|session` to `task_handoff`, defaulting to
  `group` so existing `target: <group-id>` calls retain their meaning.
- Route explicit session targets through existing assignment validation and
  direct task mail, preserving result references, supersession, and journals.
- Preserve standing-handoff deduplication by task, result, and handoff kind.
  Duplicate notices identify the standing recipient and clearly explain when
  a requested recipient differs; changing recipients never silently reassigns.
- Document result-bound findings and session-targeted review/fix examples.
  Update the team roles to use explicit handoffs for selected sessions once
  implemented, replacing their current tool-limitation workaround.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `task-results`: Agent handoffs may select a group or a named session, with
  compatible defaults, visible recipient identity, and safe duplicate behavior.

## Impact

- Agent schema, tool description, and handler in
  `src/server/team/taskTools.ts`.
- Duplicate notices in `src/server/team/TaskResultService.ts` and handoff tests
  in `src/server/__tests__/taskHandoffs.test.ts`.
- Findings-linkage regressions in the existing task-results tests; team role
  documentation and the results/handoffs bullet in `AGENTS.md`.
- Reuses `AssignmentTarget`, `AssignmentService`, mailbox delivery, and existing
  persistence. No database migration or new dependencies.
- The Results UI stays group-based. Automatic model selection, account quota
  routing, new reassignment rights, and automatic session restoration are
  outside this change. Cross-model selection remains the Lead's responsibility.
