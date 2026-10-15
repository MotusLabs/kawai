# Tasks

## 1. Expose session targets through the agent tool

- [ ] 1.1 Extend `taskSchemas.task_handoff` in `taskTools.ts` with optional
  `target_kind: group|session`, defaulting to group, and trim/refuse blank
  targets. Forward the normalized `AssignmentTarget`. Verify handler tests
  for omitted/explicit group kind, session kind for review/QA/fix, an id
  resembling a session with omitted kind, and invalid/blank input with zero
  assignment, mail, journal, or supersession writes.
- [ ] 1.2 Update the registered tool description with both target forms and
  result/response semantics. Update the AGENTS.md results/handoffs bullet.
  Verify examples parse through the real schema and old group calls still
  dispatch as before in `taskHandoffs.test.ts`.
- [ ] 1.3 Exercise the real assignment/mail path for named sessions in the
  handoff fixtures. Verify recipient identity, actor, result reference,
  expected response, atomic supersession, and ordinary direct task mail.
  Cover unknown/killed, archived, and foreign-team recipients with zero
  writes; a busy or pending-request recipient queues without interruption;
  a reviewer outside the task worktree receives context without spawning.
  Reuse existing dispatcher fixtures for delivery eligibility.

## 2. Preserve retries and result-bound responses

- [ ] 2.1 Extend duplicate notices in `TaskResultService.handoff` to identify
  the standing target kind/id, assignment id, dispatcher, and state. Compare
  requested kind/id and explicitly name mismatches with no reassignment.
  Verify same-session retries, different sessions, and both group/session
  direction changes return one unchanged standing assignment and mail row.
- [ ] 2.2 Preserve standing lookup before recipient dispatch validation and
  keep its task/result/kind predicate. Verify retries still return a standing
  handoff after recipient archive or when another invalid target is named;
  failed/superseded handoffs allow a newly validated dispatch. Re-run existing
  human-key replay, queued/delivered supersession, and parked-mail regressions.
- [ ] 2.3 Add a regression using a session handoff and actual mail claim/
  delivery transitions before `task_submit_findings`. Verify the designated
  reviewer's findings carry the exact result and handoff id, another author's
  findings do not answer that handoff, and a new submitted result inherits
  neither the earlier findings nor approval. Use `taskResults.test.ts` or
  the existing handoff fixture and run the affected suites.
- [ ] 2.4 Update Lead and relevant dev/reviewer role instructions to use
  session-targeted review/fix handoffs, preserve the cross-model gate, and
  require result-bound findings/new results. Remove the group-only tool
  workaround while retaining Lead group reports for continuity. Verify role
  examples match the schema, prose wraps to 80 columns outside frontmatter,
  and no duplicate dispatch or automatic writer replacement is prescribed.

## 3. Integration validation

- [ ] 3.1 Run `bun run lint && bun run typecheck && bun run test` and verify
  no regressions in existing group handoffs, assignment journaling, findings,
  release-and-handoff, or human request-key behavior. Record exact commands,
  outcomes, and any pre-existing warnings in the implementation result.
- [ ] 3.2 Run `openspec validate session-targeted-task-handoffs --strict` and
  `git diff --check`. Verify all scenarios map to tests or documented checks,
  no new source file exceeds 500 lines, and the change includes no UI,
  migration, dependency, or unrelated role-cap/profile edits.

## Workflow follow-up

- Review the implementation and its exact commit before integration; sync
  the delta and archive only after the normal completion criteria hold.
- On a normal server/agent restart, confirm the registered `task_handoff`
  schema exposes `target_kind` and new agents read the updated role guidance.
