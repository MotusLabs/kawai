# Agent collaboration pilot

This protocol moves architectural challenge and production-path evidence
before broad implementation. It uses the existing Lead, developer and
reviewer roles, task journals and ordinary messages. It adds no tool rights,
execution stages or automatic gates. Task revisions and linked specifications
remain authoritative; the Lead must reconcile conflicts before dependent work.

Read this document from the team's main checkout, even when working in a linked
worktree. The main checkout is the first worktree in `git worktree list
--porcelain`. References in notes should name the task revision and the exact
design note or commit examined, so another agent can continue without replaying
the conversation.

This pilot composes with the change-lead pilot (`docs/change-lead-pilot.md`):
for one enrolled change a named Change Lead coordinates the work while this
document's design challenge, production-path evidence, independent review, and
direct technical clarification apply unchanged. The two documents never assign
the same stage twice: under that pilot the Change Lead is the one formal
review/fix dispatcher for the enrolled change's results, and a coordinator's
sign-off or agreement is never presented as independent findings — the formal
review stays on the cross-model reviewer path.

## Choose the appropriate path

The Lead records whether a new assignment changes a state machine, concurrency,
recovery, security parsing, persistence, or behavior across subsystems. Such
work uses the design challenge and production-path checkpoints below. A small,
well-specified change can go directly from implementation to final review.
If the developer discovers architectural decisions inside a small task, report
them and pause only the dependent work until the Lead chooses the path.

For each pilot task, journal the risk, developer, named advisory reviewer,
checkpoint scope and next action. Prefer an eligible reviewer from a different
model family and retain that reviewer through corrections while eligible. A
senior may advise read-only, without becoming a second writer. The Lead uses
the current group definitions, live roster, routing and capacity diagnostics.
Configured caps are not running-agent counts. Recheck membership, eligibility
and availability before each request; an earlier named reviewer may no longer
be available. Discover recipients rather than relying on a fixed team size,
profile count or remembered session. Advisory group mail does not create a new
advisor automatically.

When an advisor leaves or becomes unavailable, the Lead records a replacement
or named wait. Give a replacement the current task revision, design decision,
examined commits, outstanding findings and next action. Continuity is preferred,
but does not depend on any particular agent remaining live. A fresh assessment
is conditional on eligible capacity; never assume that an additional reviewer
exists or relax a mandatory cross-model gate to fill the gap.

An unavailable advisor creates a named wait and wake-up condition, not implicit
approval. The Lead may explicitly defer or narrow a checkpoint with a reason
within authorized scope; a required acceptance check cannot be waived by mail.
Continue independent work while the decision is pending.

## Classify implementation questions before escalating

A standing team rule for every role. Before raising a question raised during
implementation, classify it against the task revision and the linked change's
approved proposal, design, delta specs, and tasks:

1. **Answered.** Those artifacts already answer it. Proceed and cite the line
   in the next note; it is not a question.
2. **Local.** The artifacts are silent, and every candidate answer stays
   inside the files the task owns and keeps every spec scenario, decision-table
   row, and stated property true. The writer decides and journals one note:
   the choice, the alternatives, and why. The formal review judges it at the
   result. It needs no dispatch, direction amendment, acknowledgement, or
   advisory round, and the writer does not wait on one.
3. **Contract.** An answer contradicts the artifacts, changes a spec scenario,
   table row, or property, changes behavior outside the task's files, or
   changes scope. Pause only the dependent work, escalate once with context,
   options, and a recommendation to the coordinator (the Change Lead under
   that pilot, else the Lead), and continue independent work. Only this class
   produces a direction amendment and its acknowledgement gate.

**Shared code is not a gate.** A suspected flaw in code the task calls but does
not own (a shared runner, store, or helper) becomes a follow-up task or change
proposal with its evidence, recorded in the journal. The task uses that code as
the approved design says. The flaw blocks the task only when the task would
make it worse, or would rely on behavior the code does not have in a way the
design did not already rely on; that case is class 3.

When unsure between 2 and 3, it is 3 only if you can name the scenario, row,
property, or outside behavior that would change; otherwise it is 2. A reviewer
or advisor who disagrees with a class-2 choice reports it at the result, as a
finding under the role's blocking rules; it does not reopen the question before
the result exists. Misclassifying a class-3 question as class 2 is a finding
the review catches; the cost of that is one fix round, which is smaller than
gating every local choice.

## Challenge the mechanism before substantial coding

The developer posts a compact `task_note` covering:

- **Invariant:** what must always remain true, including relevant boundaries.
- **Ownership:** which component owns state, transitions and persistence.
- **Production path:** entry point, composition, calls and observable outcome.
- **Failure behavior:** relevant cancellation, retry, restart and event orderings.
- **Evidence:** the test or probe that detects a broken invariant, plus affected
  existing workflows. Distinguish planned evidence from checks already run.

Reference existing design sections instead of duplicating them; name any gap
or interpretation. The Lead sends one ordinary direct message to the named
advisor with the task id, note id, revision, developer session and questions.
The advisor reads surrounding code and contracts, looks for counterexamples
and journals the assessment and unresolved risks. The Lead records proceed,
revise or defer and any required direction amendment. The developer does not
treat silence or an advisory opinion as permission to change task scope.
The challenge examines the mechanism and class-3 questions; it does not turn
class-2 choices or shared-code concerns into gates (see "Classify
implementation questions before escalating").

## Review one real production path before expanding it

The developer implements the smallest meaningful path through the actual
production composition to an observable result, with one relevant failure
case. For example, an execution Start must reach the constructed executor and
produce a state transition; constructing that executor only in a test is not
evidence of production wiring. External boundaries may use controlled doubles,
but those doubles must check their arguments and must not replace the wiring
under examination. An intentionally dormant subset must identify deferred
wiring and its later checkpoint explicitly, rather than claim activation.

Record the exact base/head, paths, checks run, outcomes and remaining scope in
a task note. Check test effectiveness while implementing: removing a guard or
running a new-behavior test on the base must fail the relevant assertion.
Preserved-behavior tests must detect a regression instead. Run only relevant
probes at this checkpoint, under the existing suite scheduling and isolation
rules; it is not a requirement to duplicate the full suite.

The advisor examines the pinned commit and challenges the production path and
failure case. Probe in a disposable checkout; use only read-only git in the
developer's worktree. Record what was actually verified, what remains claimed,
and whether a structural issue prevents expansion. The Lead journals the next
step. A materially changed mechanism needs a new assessment of affected paths;
independent work can continue when the Lead has identified its boundaries.

## Shorten technical clarification without changing authority

The appointed developer and advisor/reviewer may exchange ordinary direct
messages about reproductions, affected paths and proposed mechanisms. Include
the task id and note/result/finding references, use its `task_id` for the
direct exchange, and keep each message focused on the next technical decision.
Journal conclusions and unresolved disagreements. Send one consolidated
outcome to the `lead` group, without `task_id` and with the task id in the body,
so it reaches the current Lead under the existing reporting convention. Under
the change-lead pilot that consolidated outcome goes to the named coordinator
instead, with the `lead` group kept for the unavailable-coordinator escalation
(`docs/change-lead-pilot.md` §4).

When a response is needed, journal the named wait and end the turn at a safe
boundary so normal mail can deliver. Do not busy-poll, send acknowledgement
loops or use urgent interruption for routine clarification. If one exchange
does not resolve a disputed mechanism or criterion, send the evidence and
options to the Lead for a decision rather than continuing an open-ended debate.
Clarification about a class-2 choice never holds the writer: the writer
decides, journals it, and the exchange continues at the result if needed.

The Lead need not relay each question. The Lead still owns direction and
assignment decisions within its rights; creator/human acceptance and amendment
rights remain unchanged. A reviewer cannot assign fixes, amend acceptance or
approve a different commit through conversation. If the criterion is wrong or
ambiguous, ask the Lead to reconcile it rather than invent a code defect.
The Lead coordinates any formal handoff; technical mail must not duplicate it.

## Correct the invariant, then check that it holds

An architectural finding concerns ownership, lifecycle, composition or a
cross-path invariant, rather than an isolated typo or local defect. At the
first such finding, the developer records this correction plan before coding:

```text
Task / revision / examined note or result / base and head:
Violated invariant:
Reproduction and observed outcome:
Affected construction, transition and execution paths:
Correction mechanism and why it covers those paths:
Regression tests, variants and relevant boundaries:
Guard removal or base-commit check and expected failing assertion:
Unresolved decision / responsible actor / next action:
```

The reviewer challenges the plan; the Lead resolves architectural direction
before dependent edits. The correction must cover the defect class as well as
the original reproduction. On re-review, distinguish closed, still open,
regressed and new findings. If the first correction still violates the same
invariant, reopen the design with the Lead before another patch; consider a
read-only senior assessment or an explicit takeover. Keep one writer.

For other defect classes, the convergence signals and the backstop decide
when a change needs a diagnosis instead of another fix (see "Convergence" in
"Review protocol"). Environmental failures and clarified acceptance criteria should be
recorded separately from code defects. Pause only affected work, keep other
authorized work moving and do not infer permission to stop an execution.

## Keep advisory checkpoints separate from final review

Advisory exchanges use `task_note` and ordinary messages, naming the examined
note or exact commit. They do not use `task_handoff`, `task_submit_findings`,
or an incomplete `task_submit_result` to simulate a new checkpoint stage. A
result submission can advance execution-owned work into its review round;
a handoff can supersede the current assignment. Neither is a harmless way to
ask for advice. Never submit a partial production path as a completed result.

Final review retains the existing exact-result/exact-commit contract and
cross-model routing in the role instructions. Recheck checkpoint evidence
against the final head and review conflict resolutions. The eligible continuing
reviewer may perform the formal review; any design input is disclosed, not
presented as a second independent assessment. The Lead coordinates one formal
handoff for manually managed work; under the change-lead pilot the enrolled
change's handoff belongs to its Change Lead, still exactly one per result and
never the coordinator's own sign-off recorded as findings. For execution-owned
work, Kawai owns review
and fix dispatch; agents must not insert manual stages, reassign it or bypass
retry/stop rights. Advisory notes never satisfy its review or acceptance gates.

For security-sensitive behavior, concurrency, recovery or irreversible effects,
the Lead should seek an additional fresh read-only assessment of the critical
invariant from a non-author who did not shape the mechanism. Request it by
ordinary direct mail before final submission, record its independent probes
and resolve material findings before submission. This additional assessment
is advisory; it does not dispatch a second stage or replace the formal review.
If no suitable fresh assessor is available, record that limitation and the
Lead's next step; do not claim that two independent reviews occurred.

Kawai watches the budget on manually managed tasks. When a task no execution
owns gathers 10 messages from agents or the human, and 3 hours pass, with
no new revision, result, or counted review, Kawai journals a stall notice
and sends the task's creator one message tagged `task-stall`. The notice
is advisory: nothing waits on it. The creator then chooses one of: submit a
complete result for formal review, journal the specific risk that another
advisory round targets, narrow the task, or escalate.

## Review protocol

A formal review is a list of findings on one exact result, submitted with
`task_submit_findings` as structured `items`. Kawai classifies each item,
derives the verdict, and keeps one findings ledger per task. `task_get`
shows the ledger, and the Team page's task detail shows it too. A plan
change's review is refused in the old text form. On other tasks the text
form still works, but it never enters the ledger.

- **Levels.**
  - P0: security, data corruption, or severe correctness.
  - P1: a reproducible requirement violation or a significant regression.
  - P2: advisory. **P2 never blocks.**
- **Clause rule.** A P0 or P1 cites the clause it violates. Write
  `<identity> › <clause id>` or a bare `A1`. On a task without a contract,
  cite the revision identity alone. A finding with no citation, a stale
  identity, an unknown clause, or an `X*` clause is out of contract and
  never blocks. Report requests for work outside the contract as
  follow-ups, not findings.
- **Evidence rule.** A P0 or P1 needs evidence (a `file:line`, test output,
  or a counterexample) and an impact. A reproduction is optional. Without
  evidence and an impact the finding is unsupported and never blocks.
- **Verdict.** A round fails exactly when an accepted P0 or P1 is open
  (accepted, still open, or reopened). Nobody states the verdict; the
  submit reply lists each item's class. Read it.
- **Verify rounds.** On a newer result, give a disposition for every
  blocking finding `task_get` lists: `resolved`, `still-open`, or
  `regressed` (the last two with evidence). A new finding with the same
  clause and file as a resolved one reopens it. While a finding still
  blocks, raising it again is refused: give its disposition instead.
- **One counted review per result.** On a plan change, the review that
  counts is the one answering the review handoff as its claimant. On other
  tasks, any structured review counts. A corrected review replaces the
  first until the review becomes final, which happens when one of its
  findings is disputed, a newer result's review counts, or its round is
  decided.
- **Fixing.** The fix instruction lists only the blocking finding ids.
  Fix those, minimally, and nothing else. Other findings in `task_get` are
  not required.
- **Disputes.** A developer who can refute a finding disputes it with
  `task_dispute_findings`, giving counter-evidence, instead of changing
  code. A finding can be disputed once in each state it enters. On a plan
  change, each dispute raises a decision card for the plan's Lead role (or
  the owner). On other tasks, the task's creator or the human decides with
  `task_decide_dispute` and a rationale. Upholding restores the finding's
  state before the dispute. Rejecting makes it `rejected`, which never
  blocks. A pending dispute holds the round. A failed round whose blockers
  are all rejected passes on its result again, with no new commit.
- **Revisions.** Publishing a revision with a new contract re-maps each
  open finding by its clause id. A finding with no clause left to cite is
  superseded and no longer blocks.
- **P0 alerts.** An accepted P0 on a plan change sends the Lead role a
  `review-p0` message. The round fails and the fix goes out as usual.
- **Convergence.** Kawai reads the reviews of the current window (the
  reviews under the current contract hash since the last pass and the last
  closed diagnosis) for five signals:
  - S1, oscillation: a finding reopened a second time;
  - S2, moving clause: two reviews in a row each resolve a finding on a
    clause and raise another on it;
  - S3, churn: the newest review raises, and raised keeps pace with
    resolved over the last two;
  - S4, stagnation: the open P0/P1 count does not fall over three reviews;
  - S5, scope pressure: two reviews in a row raise out-of-contract findings.

  When a plan change's round fails and a signal fires on its review, or the
  failed fix rounds reach the team's backstop (`maxFailedFixRounds`, 5 by
  default), Kawai sends no fix. It opens a diagnosis and asks the plan's
  Lead role (else the owner) a card in its own name. A signal never decides
  a finding. Decide with `decision_record`, giving `option_index` and a
  rationale; the card takes only its options, and the outcome is the reply:
  - **Fix round**: the next fix is likely to converge. The fix carries your
    rationale, and the count starts again.
  - **Reject F…**: the named blockers are wrong. They read rejected; if
    nothing else blocks, the result passes with no new commit.
  - **Amend the contract**: the contract asks for the wrong thing or too
    much. Kawai waits for the owner to publish a task revision, then sends
    the fix naming it. You cannot publish it.
  - **Reassign to <group>**: the group cannot finish it. The fix and every
    later one go to the other group.
  - **Escalate**: the change stops for the owner, who may Retry it.

  On a task no execution owns, the same signals journal a notice and mail
  its creator once per counted review; apply the same judgment.

When the work carries acceptance oracles (see the next section), they
decide the level. A missing, unfaithful, or vacuous oracle test, a
counterexample to a stated property, and a security or data-loss bug with a
reproducer are P0 or P1. Any other substantive finding is P2.

## Write acceptance as oracles

Risky work is accepted against oracles written before any of it is coded: a
decision table of observable results, plus one property per invariant. The
linked change's design carries them, so the developer, the cross-model
reviewer, a replacement and a restarted execution all judge the same rows
instead of re-deriving intent from prose. A small, well-specified change
needs none; decision logic, state machines, parsing or security checks, and
concurrency do (`openspec/config.yaml` `rules:` carries the same rule for
artifact authors).

The design's "Acceptance oracles" subsection holds:

- **Decision tables** of observable results only — inputs × outputs, `*`
  for a don't-care, and unreachable combinations listed with their reasons.
  Every row has an oracle id.
- **One property per invariant**, giving the property, the generator, the
  seams, a fixed seed and a case count, with no new dependency.
- For a state machine with recovery, a **completeness claim** — every
  combination of the axes matches exactly one row or one unreachable claim —
  and model-based tests that run the table as the reference model under
  seeded command sequences with replays, supersessions, and a crash at each
  transaction boundary.

For a state machine with recovery, the tables get a blind second reading
before code starts; other oracle work may opt in:

1. Commit A1 holds the inputs only, with every output `?`.
2. An advisor from another model family fills in the outputs from the spec
   alone, without seeing the author's expectations.
3. Commit A2 holds the author's outputs; the two readings are diffed, and
   each disagreement is resolved in the table, not in mail.
4. The Lead records the resolved oracles as binding before code starts.

The executable forms follow the table into the test tree: each row is
committed verbatim as a table-driven test next to the code it covers, and
each property runs as a seeded generator over the named seams. For a state
machine with recovery, the completeness test expands the axes over the
table and the unreachable list, so it has no gap and no overlap, and the
model-based tests run the table as the reference model; a failing seed
found on the way becomes a named table row.

Keep a coverage map from every requirement and behavioral scenario in the
assigned scope to its oracle row and test, and keep it current across task
revisions: tests for changed behavior must detect its absence, and tests for
preserved behavior must detect regressions. An oracle exercised only through
a hand-built harness is not coverage — at least one oracle test per guarded
seam runs through the production composition, and its mutant removes the
wiring.

What blocks is decided by the levels in "Review protocol" above. For work
whose acceptance has oracles, only a missing, unfaithful, or vacuous oracle
test, a counterexample to a stated property, or a security or data-loss bug
with a reproducer is P0 or P1. From round 2, only regressions (`regressed`),
unfixed findings (`still-open`), and new counterexamples with reproducers
block.

Amendments go through the table, not around it: a defect that is neither in
the tables nor in the verdict rule's three blocking classes is a new defect
class, proposed as an oracle amendment the Lead decides and recorded as an
entry in `docs/oracle-hazards.md` — the hazard catalog organized by change
class. A missing row alone never downgrades a blocking class: a stated
property's counterexample and a reproducible security or data-loss bug
block with or without a row, as does untested production wiring. Add an
entry for every new blocking finding, naming the class, the hazard, the
oracle row or property that would have caught it, and the source finding.

Read the rule's effect through `team_metrics`: first-pass review yield and
fix iterations, with reopen rate as the guard metric. Pilot evidence: RC E
ran 1 failed review over 5 results; its baseline RC D (task-707555cd) ran 2
failed reviews over 10 results. Both samples are n=1, so the comparison is
undetermined.

## Write the implementation contract

A code task carries an implementation contract: the clauses its result is
judged against, published as part of a task revision. The developer, the
reviewer, and the human all cite the same identity — `r3#9f2c4ab1e07d`,
the revision and the first 12 hex digits of the contract hash — and its
clause ids, so a finding names what it holds the result to
(`r3#9f2c4ab1e07d › I2`) instead of re-deriving intent from prose.

Whoever owns the work's direction writes the contract: the architect in the
change's `design.md`, the Lead or the Change Lead on the task. A plan
execution copies the section from `design.md` at the execution's baseline
commit into the task's first revision; the `implementation-contract`
validation check refuses a plan whose change has no section, or one that
does not parse.

The section is five headings in this order, each part a list of bullets:

```markdown
## Implementation contract
### Acceptance
- A1: `bun run export` writes one CSV row per open task, header first.
### Invariants
- I1: The export never writes a file outside the run's output directory.
### Scope
- `src/server/export/**`
- `src/shared/exportRows.ts`
### Verification
- V1: `src/server/__tests__/export.test.ts` passes, covering A1 and I1.
### Excluded
- X1: No client button; the Team page export arrives separately.
```

- **Clauses a reviewer can judge pass or fail.** Name an observable
  result: an output, a refusal, a file, a count. "Writes one CSV row per
  open task" can be checked; "handles exports well" cannot. Invariants say
  what must never happen; each gets an id a finding can cite.
- **Scope lists what may change, not what will.** One glob per bullet,
  relative to the repository root; `*` stays within one directory and `**`
  crosses them. The linked change's own directory is always in scope. The
  result check lists every changed path outside it — informational, never a
  gate — so a needed edit outside scope is a reason to ask for a revision,
  not to widen it silently.
- **Exclusions are explicit.** Work left for later, or for another task,
  is an `X` clause; a reviewer's request covered by one, or by nothing in
  the contract, does not block.
- **Changes go through a published revision.** Amend the task's contract
  with `task_amend` (or publish it from the Team page); the revision bumps
  and the identity changes with it. Editing `design.md` on a change branch
  never changes a running task's contract, and once a revision carried a
  contract it cannot be removed, only replaced.

## Roll out and evaluate

New agent starts load the revised group instructions. Running agents retain
their loaded prompt; do not restart, interrupt or contact them automatically
to apply this pilot. At the next safe checkpoint, the Lead can send ordinary
instructions referencing this protocol, within the current task direction and
without changing execution ownership. Preserve ongoing work and pending mail.

Pilot the protocol on the next few risky tasks. At each design decision,
checkpoint and correction outcome, record a task note with the note/commit
reference, defect class, discovery phase, responsible actor, next action and
timestamp. Use those records to compare:

- Architectural defects first discovered during final review.
- Repeated corrections of the same invariant.
- Elapsed time from a blocking finding to verified closure, separating named
  quota, reviewer, suite and human waits where evidence exists.
- Reviewer waiting time and Lead relay messages, including checkpoint overhead.

These are manual pilot observations, not new built-in metrics. Keep code,
coverage, integration, contract and environment outcomes distinct, and attribute
takeovers explicitly. Report available counts and uncertainty; do not invent
missing timings or infer a model ranking from unlike tasks. Review the pilot
in the existing process reports before proposing broader enforcement.
