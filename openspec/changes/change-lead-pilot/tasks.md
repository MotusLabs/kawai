# Tasks

## 1. Establish the integrated baseline and pilot protocol

- [ ] 1.1 Resolve the authoritative branch containing the implemented parallel-suite and per-result-suite changes before implementation; record the base SHA and actual affected-test/full-check commands in the implementation journal, verifying the hooks/scripts agree with that baseline without modifying unrelated planning artifacts.
- [ ] 1.2 Create `docs/change-lead-pilot.md` with enrollment criteria, one-change scope, authority matrix, parent/child direction templates, escalation and integration boundaries, and the 14-day default evaluation window from design D1-D5; verify a worked two-subtask example maps every implementation requirement to a coordinator, writer, dependency, and acceptance check.
- [ ] 1.3 Add the baseline/evaluation template to the protocol: task ids, scope/risk/model/resource conditions, timestamps, waits without overlap double-counting, defects, corrections, all participant token/cost coverage, failed/abandoned work, and limitations; verify sample complete and partial evidence yield explicit conclusions or unknowns without attributing quota percentages as costs.

## 2. Introduce the role and coherent reporting

- [ ] 2.1 Add `.kawai/groups/change-leads.md` using design D2 rights and existing tools; document human-created session enrollment in a stable checkout and the absence of automatic spawning, then verify the real file through the existing group parser/catalog with permitted task creation, cross-worktree coordination, and denied plan/mailbox-management/process-report rights.
- [ ] 2.2 Update `.kawai/groups/lead.md` to enroll one change, retain cross-change contract and landing ownership, delegate creator-owned children and local decisions, reconcile shared capacity, and avoid duplicate dispatch; verify a tabletop local clarification resolves without Team Lead approval while a cross-change contract change escalates.
- [ ] 2.3 Update all three developer roles and `reviewers.md` with the same opt-in coordinator/reporting exception, result-bound review rules, unavailable-coordinator escalation, and ordinary-work fallback; verify pilot routine reports use named-session mail without task binding, technical exchanges retain task references, and non-pilot reports still target `lead`.
- [ ] 2.4 Link and reconcile `docs/agent-collaboration.md` with the pilot while retaining its design challenge, production-path evidence, independent review, and direct technical clarification; verify the worked path has exactly one formal review/fix dispatcher and makes no claim that a coordinator's sign-off is independent findings.

## 3. Exercise ownership, recovery, and withdrawal

- [ ] 3.1 Reuse existing task/handoff test coverage and extend disposable fixtures only for uncovered pilot composition: Team Lead parent, Change Lead child creation, parent/child creator asymmetry, child result, explicit-session independent review, and duplicate handoff retry; verify no new rights, duplicate instructions, or inherited result approval appear.
- [ ] 3.2 Document coordinator-loss and replacement procedures in the protocol and exercise the existing authorization path in a disposable fixture: a replacement cannot amend/close old children, the original creator or human publishes the handover, and the authorized actor can finish closure; verify branch/result/mail references survive and work is not recreated to obtain rights.
- [ ] 3.3 Document and tabletop withdrawal with an in-flight implementation and outstanding review: stop new pilot dispatch, reconcile creators and standing handoffs, amend reporting through authorized actors, retain the role until dependencies settle, and preserve evidence; verify no automatic session restart, kill, deletion, duplicate review, or premature parent completion is required.
- [ ] 3.4 Declare role/docs runtime reads where the integrated affected-test selector requires them, and run the focused role/task/handoff tests through its supported runner; verify actual changed-path selection covers these fixtures, with logs identifying which behaviors are mechanically tested versus only walked through.

## 4. Integration readiness and pilot handoff

- [ ] 4.1 Walk the complete documented flow from enrollment through two separately owned task groups, assembly, resulting-head review, contract checks, and Team Lead landing; verify coverage of every delta scenario, exclusion of execution-owned changes, shared-cap compliance, and separation of task closure from result acceptance.
- [ ] 4.2 Run the authoritative baseline's required full check on the final implementation tree and `openspec validate change-lead-pilot --strict`; record outcomes and known limitations, verifying the patch changes no server/API/schema/CI behavior and preserves the implemented test policy.
- [ ] 4.3 Deliver a pilot-readiness note with role/protocol references, a candidate-selection checklist, baseline-selection method, human session/enrollment action, report cutoff, and rollback checklist; verify installation alone sends no live mail and starts or enrolls no sessions.

## Workflow follow-up

- After implementation review, the human names an eligible change and coordinator session. The Team Lead records the enrollment, baseline evidence and window before the Change Lead dispatches work; do not mark the pilot successful merely because the protocol was installed.
- At landing, withdrawal, or the evaluation-window boundary, the Team Lead publishes the evidence-backed continue/revise/withdraw recommendation and limitations. Expansion requires a human decision.
- Archive this change after its implementation checks and repository review requirements are satisfied; retain live pilot evidence in the enrolled task records independently of artifact archival.
