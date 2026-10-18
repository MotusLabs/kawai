# Design

## Context

See proposal.md for motivation. `taskSchemas.task_handoff` currently accepts a
string `target`; its handler unconditionally constructs a group target.
`HandoffRequest.target` and `AssignmentTarget` already support groups and
sessions. `AssignmentService.dispatch` validates new session recipients,
persists their identity, enqueues task-bound direct mail, and journals the
handoff in the same transaction as supersession.

`TaskResultService.handoff` resolves an existing agent handoff by task,
result, and kind before dispatch. That ordering protects retries even when
the recipient has since become unavailable. Its notice currently shows an
assignment id, dispatcher, and state but omits the recipient.

`submitFindings` already links findings to the caller's outstanding handoff
when its result and claimant match. The Results UI and human handoff form
use group targets, while the underlying connection accepts AssignmentTarget.

## Goals / Non-Goals

**Goals:** Expose existing session assignment semantics to agents without
changing old calls, duplicating a stage, or bypassing assignment validation.
Ensure handoff recipients and result-bound responses are inspectable.

**Non-Goals:** UI target pickers, database changes, new tools, automatic model
selection, account-level failover, new acceptance/ownership rights, and a new
agent reassignment operation. The Lead still chooses the reviewer family.
A session-targeted fix does not authorize concurrent worktree writers.

## Decisions

### D1. Add a compatible recipient-kind field

Extend the schema in `src/server/team/taskTools.ts` with optional
`target_kind: group|session`, defaulting to group. Keep `target` as a string;
normalize surrounding whitespace and refuse an empty identifier. Pass the
normalized kind and id to the existing service. Update the registered tool
description with both forms and the retry behavior.

Examples (other required fields omitted for readability):

```json
{"target": "reviewers"}
{"target_kind": "group", "target": "reviewers"}
{"target_kind": "session", "target": "chat-reviewer-example"}
```

The first two route identically. Never infer a kind from an identifier prefix.
This follows the mailbox's explicit kind/id convention and avoids a breaking
object-shaped target. A union of string/object targets was considered, but
adds schema complexity without improving recipient selection.

### D2. Reuse dispatch validation and lifecycle

For a new handoff, continue through `TaskResultService.handoff` and
`AssignmentService.dispatch`. Do not duplicate session validation in the
adapter. Unknown or killed (no live record), archived, and other-team session
targets fail before assignment, mail, journal, or supersession writes.
Busy but valid sessions accept queued normal-priority direct mail. Different
worktrees do not prohibit a named session target. Direct mail neither spawns
another reviewer nor bypasses pending-request eligibility. It carries the
existing task context and result reference.

Do not restore an archived target as a convenience: assignment dispatch
currently refuses it, even though plain direct messaging can restore one.
That existing difference is deliberate for this change. Removing assignment
validation or routing session handoffs as plain messages would lose safety
and the durable stage record.

### D3. Preserve retry identity and expose the actual recipient

Keep the standing-equivalence predicate unchanged: same task, result, and
kind, not superseded and not failed. Preserve its position before dispatch
recipient validation. Return the existing assignment with `duplicate: true`.
This includes delivered work and handoffs originally dispatched by the human.

Always include `targetKind` and `targetId` in the duplicate notice, retaining
assignment id, dispatcher, and state. Compare the requested normalized kind/id
with the stored target. On a mismatch, name both and explicitly say that no
reassignment occurred; instruct the caller to inspect the standing assignment.
Preserve the existing assignment and instruction exactly.

Including the recipient in equivalence would allow a retry to supersede work
merely by changing a target; rejecting all changed-target retries would alter
the shipped return-the-standing-stage contract. A more explicit notice solves
the ambiguity while preserving both compatibility and the one-stage rule.
Failed or superseded handoffs have no standing and a later call can dispatch
again, subject to normal validation. No new retry key or retarget API is added.
Human keyed replay behavior remains unchanged.

### D4. Keep findings tied to the dispatched stage

Verify the existing path rather than creating a second linkage mechanism:
a session receives and claims its handoff mail, submits `task_submit_findings`
for that result, and the stored finding names the outstanding handoff id.
Another reviewer can still submit findings under current team rights, but
they do not answer the designated claimant's handoff. A newer result inherits
neither the earlier findings nor their approval.

In `.kawai/groups/lead.md`, replace the group-only workaround with explicit
session `task_handoff` calls for the chosen cross-model reviewer and original
developer, including base/head SHAs and result id. Keep reporting to the Lead
as group mail for continuity, without duplicating the handed-off instruction.
Reviewers submit findings and developers submit new results after fixes;
update their guidance where the former tool limitation is described. Update
the existing AGENTS.md results/handoffs bullet to describe the new input.
These documentation edits happen during implementation, not this proposal.

## Risks / Trade-offs

- A wrong reviewer can be selected explicitly: retain the Lead's cross-model
  routing rule and the reviewer's mismatch refusal; this change does not
  enforce model independence in the generic assignment service.
- A retry can name a different or now-invalid recipient: return the standing
  assignment first, with an unambiguous mismatch notice, without side effects.
- A selected reviewer can remain busy: ordinary mailbox reasons explain the
  wait; explicit session selection intentionally does not fall back to others.
- Group selection is still useful for staffing: retain its defaults, routing,
  caps, worktree behavior, and existing regression tests.
- Claim-based findings linkage can be missed by shallow tests: exercise claim
  and delivery transitions before asserting the persisted handoff id.

## Migration Plan

No data migration or dependency changes. Deploy the additive tool schema and
handler with the notice update, then restart agents through normal lifecycle
so they discover the new tool definition and updated role instructions.
Existing group calls and stored assignments continue working. Rollback
restores the former tool adapter; previously stored session assignments,
mail, and findings remain readable by the existing backend and UI.

## Validation

Extend `taskHandoffs.test.ts` for default/explicit group calls, all three
session handoff kinds, recipient refusals with zero writes, normal queued
mail, cross-worktree selection, repeated calls, target-kind changes,
recipient lifecycle changes, and failed-stage redispatch. Preserve keyed
human replay and supersession regressions. Extend `taskResults.test.ts` (or
the shared handoff fixture) to prove real session handoff claims link findings
to the exact result and stage. Use existing dispatcher fixtures for direct
mail delivery; do not simulate independent routing logic in a unit test.

Run `bun run lint && bun run typecheck && bun run test`, check prose wrapping
and tool examples, and validate this change with OpenSpec strict validation.
No UI changes or end-to-end browser test additions are required.
