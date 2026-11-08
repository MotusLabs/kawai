# Proposal

## Why

Review and fix rounds often loop instead of converging. One root cause is that
nothing pins down what a result is judged against. A task revision carries
free-text direction and acceptance. The linked OpenSpec change is the
authoritative direction, but it is just files on a branch, with no version
(devs even tick `tasks.md` boxes on it). So a reviewer cannot cite the clause
a finding violates, cannot tell an in-contract defect from a design
preference, and a changed specification cannot be told apart from an
ordinary file edit.

This is the first of three changes toward a convergent review protocol. The
other two are `review-findings-ledger` (structured, gated findings that cite
contract clauses, a rebut action, and fix instructions that carry only
accepted findings) and `review-convergence` (convergence signals over the
ledger, a DIAGNOSE decision card, and a backstop that replaces the
three-failed-fix-rounds stop). Both depend on clause ids and a contract hash,
which this change introduces.

## What Changes

- A task revision may carry an **implementation contract** with five parts,
  each with stable clause ids:
  - functional acceptance criteria (`A1..An`)
  - non-functional constraints and invariants (`I1..In`)
  - the allowed scope of modification (path globs)
  - required verification (named checks and evidence)
  - explicitly excluded work (`X1..Xn`)
- Kawai computes a canonical **contract hash** over the contract's content.
  The contract is identified as `r<N>#<hash>`, and a single clause as
  `r<N>#<hash> › <clause-id>`.
- A contract changes only through deliberate publication of a new task
  revision (the existing creator- and human-only rights). An amendment that
  omits the contract carries it forward unchanged, and a contract once set
  cannot be dropped. It is never inferred from file edits, including edits
  to the linked change's artifacts on a dev branch.
- For plan execution, Kawai snapshots each change task's contract once, at
  task creation, from a required "Implementation contract" section of the
  change's `design.md` at the baseline commit. After that, only the human's
  published revisions change it. A section that is missing at creation (an
  execution started before this change) yields a task without a contract,
  journaled.
- **BREAKING:** plan validation adds an `implementation-contract` check that
  errors on a change without a well-formed section, and raises the checks
  version. Every earlier report reads Out of date, so approved but unstarted
  revisions must be validated again, and their changes need the section.
  Running executions are unaffected.
- Delivered task messages, `task_get`, revision notices, and the revision
  history carry the contract identity and its clauses.
  `task_acknowledge` is unchanged: a revision fixes its contract, so
  acknowledging the revision acknowledges the contract.
- Kawai adds a non-gating **scope check** to result checks: it lists the
  files a result changes outside the contract's allowed scope.
- Tasks without a contract (all existing tasks, and ad-hoc tasks created
  without one) keep working. They are identified by a hash of their
  direction and acceptance text, with no clause ids and no scope check.
- Role prompts and `docs/agent-collaboration.md` tell the Lead, Change Leads
  and architects how to write the contract, devs to work only within it, and
  reviewers to cite clause ids. The `openspec/config.yaml` design rules
  require the Implementation contract section.

## Capabilities

### New Capabilities

- `implementation-contract`: the contract model (the five parts, clause ids,
  their validation), the canonical hash and contract identity, derivation
  from a change's `design.md` section, and the legacy whole-text fallback.

### Modified Capabilities

- `team-tasks`: a revision may carry a contract, amendments carry it forward
  or replace it, and task reads and delivered task messages show it.
- `task-revision-publication`: drafts, publications, and `task_amend` carry
  the contract; a malformed contract refuses publication.
- `plan-execution`: "Kawai creates and dispatches one task per change"
  snapshots the task's contract from the change's `design.md` at the
  baseline commit; artifact edits never change it afterwards.
- `plan-validation`: each named change must carry a well-formed
  Implementation contract section, and the checks version rises.
- `task-results`: result checks gain the non-gating scope check against the
  contract's allowed scope.

## Impact

- **Data:** a numbered migration adds nullable contract columns to
  `team_task_revisions` and `team_task_drafts`. Existing rows stay as they
  are; their text identity is computed on read.
- **Server:** `src/server/team/` (task store, task service, revision
  publication, task tools, task context); `src/server/verification/`
  (the scope fact); `src/server/plans/execution/` (task creation,
  instructions);
  `src/server/plans/validation/` (the contract-section check); a new
  contract parser and hasher in `src/shared/`.
- **Agent tools:** `task_create` and `task_amend` accept a structured
  contract (as Markdown text in the contract grammar); `task_get` and task
  mail headers include it.
- **Client:** the task view and its revision history show the contract and
  its clauses; the task form gains contract fields.
- **Prompts and docs:** `.kawai/groups/lead.md`, `change-leads.md`, the dev
  and reviewer role files, `docs/agent-collaboration.md`,
  `openspec/config.yaml` (design rule), and `docs/architecture/` (the tasks
  bullet).
- **Interaction with in-flight changes:** `revision-control` owns how a new
  task revision returns a running change for re-evaluation. A
  contract-changing revision rides that same path unchanged, so this change
  only needs it merged first, not modified. `delivery-outcome-metrics` is
  unaffected.
- **Out of scope here:** the structured finding schema, gate, ledger and
  rebut action (`review-findings-ledger`); the convergence signals, DIAGNOSE
  card and backstop (`review-convergence`).
