# Proposal

## Why

`durable-plans` gives the team a human-approved plan record, but approval checks only the record itself:
- the plan is open;
- the revision is in review;
- the hash matches;
- no other approval raced it;
- the strategy pin is current.

Nothing checks the plan against the world it will run in. The named OpenSpec changes may not exist or may not pass strict validation. Two changes may rewrite the same requirement with no order between them. The groups and profiles may be unknown, and another open plan may already land on the integration branch. Nobody records whether the plan advances the approved strategy. `durable-plans` deliberately left all of this out (design D3: "Checks against the environment run only at validation"). It also reserved the hook: `plan-validation` appends `validation-current` to the approval preconditions (D7, contract C4).

`docs/multi-agent-development-ux.md` ("Validate Plan", P0 Validation/integration, cases R03, R04, and R06) asks for a validated, consistent snapshot before Ready:
- The report separates blocking errors, warnings, mandatory questions, evidence, and decisions.
- Blockers and questions are resolved before Ready, and accepting a warning needs an authorized rationale.
- Conflicting schema changes prevent Ready even without a graph cycle.
- A stale input hash is rejected.

`docs/product-strategy.md` ("Plan alignment and trade-offs", S06, S11, S15) adds the alignment report:
- It uses five assessments.
- A conflict blocks Ready until the owner records an exception.
- With no approved strategy the plan is "Alignment unassessed", never a fabricated binding.

Strategy revision 2 states the owner's side: "the owner owns intent and the plan" (P1), and plans add checks but never remove the floor (P6).

## What Changes

- **Validation reports.** Validating a plan revision (`in_review` or `approved`) produces an immutable report. The report records:
  - its inputs and their input hash;
  - every check result, each as an error, a warning, or evidence;
  - the alignment state;
  - the questions and human decisions it consumed;
  - whether the revision is ready.

  The human (**Validate**) and any team agent (`plan_validate`) can request one. Validating unchanged inputs again returns the newest report and writes nothing. An agent can also dry-run a draft; that report is returned and never stored.
- **Inputs and identity.** The input hash covers:
  - the plan revision and content hash (which already binds the strategy pin);
  - the strategy impact state (`strategy-revision-impact` C-I2);
  - each change's artifact digests (proposal, design, tasks, and delta specs);
  - the base specs those deltas touch;
  - the definitions of the named groups and the known profile ids;
  - the other open plans' claims on the plan's changes and branch;
  - the OpenSpec adapter's version and capabilities;
  - the version of kawai's own check set;
  - the assessments and decisions recorded for the revision.

  The repository baseline commit is recorded as evidence, never as identity. Master moves with every merge, including the plan's own landed changes. The identity therefore covers exactly the files and records the checks read.
- **Technical checks**, mechanical and deterministic:
  - the OpenSpec adapter is available;
  - every change is registered and unarchived;
  - every change passes `openspec validate --strict`;
  - the strategy impact gate passes (C-I1);
  - the named groups and profiles exist;
  - an integration branch is not claimed by another open plan;
  - a change named by another open plan is flagged.

  Capacity (caps, live members, cooling profiles) is evidence only.
- **Typed relations from spec deltas.** For each pair of changes:
  - two changes that modify, remove, rename, or add the same requirement conflict, an error (R04), unless `dependsOn` orders one before the other;
  - two changes that touch the same capability unordered overlap, a warning;
  - an ordered pair is recorded as serialized.
- **Assessment.** Agents and the owner record the judgment kawai cannot compute. Each record is bound to the plan revision.
  - An alignment assessment takes one of five values: aligned, aligned-with-conditions, exploratory, conflicting, or insufficient-information. It maps the plan to the pinned strategy's outcomes, and its conditions are gated at Ready, Start, or acceptance.
  - Mandatory and optional questions; R03's ambiguous migration strategy is the example.
  - Warning findings on intent and implementation strategy.
  - With an empty pin, alignment is **unassessed**. That is allowed and labeled, and it is never one of the five values (S11).
- **Owner decisions, human only.** The owner can:
  - answer a question;
  - accept a warning with a rationale;
  - resolve a Ready-gated condition;
  - record a scoped exception to a conflict;
  - authorize bounded exploration.

  Each decision is append-only and idempotent under a command id. No agent tool records one. A `conflicting` assessment keeps blocking until the owner's exception, even after a later assessment (S06).
- **Readiness.** A report is ready when:
  - it has no errors;
  - every mandatory question is answered;
  - every warning is accepted;
  - alignment is unassessed or passes.
- **Approval precondition `validation-current`.** Approving a revision requires its newest report to be ready, with an input hash that equals the inputs recomputed at approval. File-held inputs are read just before the approval transaction, and records inside it. The refusal names what changed, or what still blocks. Start (`plan-execution`) binds to the same comparison (R06).
- **Agent tools.** `plan_validate`, `plan_validation_get`, and `plan_assess`, all allowed without cards. None decides, accepts, or approves.
- **Plans view.** Each in-review or approved revision gets a Validation section:
  - its standing: Not validated, Blocked, Ready, or Out of date, with the changed inputs named;
  - the report, grouped as the UX doc's rows (Product alignment; Intent and implementation strategy; Scope and relations; Readiness);
  - the owner's decision controls, plus an assessment form for the owner.

  The approve dialog shows the standing.

Non-goals:
- running builds, tests, or CI. The check floor belongs to `plan-execution` (C7), and validation here is static.
- the UX doc's Contracts row, and declared relations such as "consumes" or "supersedes". No contract revisions exist, and strategy revision 2 does not ask for them (`durable-plans` non-goals).
- the Delivery and recovery row (`plan-execution`, `execution-safety-recovery`);
- relations with changes outside the plan;
- validating automatically on save, submission, or strategy approval;
- the Start gate itself. `plan-execution` owns Start and binds to this change's contracts.
- revoking a decision, or carrying decisions to a new revision. The view offers an earlier answer as a starting point.
- assessments generated by the kawai server. Assessments come from team agents or the owner.
- budgets and permission grants (no model exists yet).

## Capabilities

### New Capabilities

- `plan-validation` covers:
  - reports, inputs, and identity;
  - the technical checks;
  - typed relations;
  - questions, findings, and warning acceptance;
  - readiness;
  - the `validation-current` approval precondition;
  - the agent tools;
  - the Plans view's Validation section.
- `plan-alignment` covers:
  - the alignment assessment and its five values;
  - strategy references and conditions;
  - the unassessed state;
  - the sticky conflict rule;
  - the owner's exception and exploration decisions;
  - the alignment part of readiness.

### Modified Capabilities

None. `plan-approval` already allows later capabilities to add preconditions ("Approval evaluates named preconditions"), and `validation-current` is added under `plan-validation`. Approval still grants and triggers nothing else, and validation writes nothing outside its own tables.

## Impact

- **Server.**
  - New `src/server/plans/validation/`:
    - `validationSchema.ts` and `validationStore.ts`: the `plan_validation_reports`, `plan_assessments`, and `plan_validation_decisions` tables;
    - `openspecAdapter.ts`: version and capability probe, `validate --strict --json`, and `show --json --deltas-only`;
    - `validationInputs.ts`: file-held identity, without the CLI;
    - `validationChecks.ts`;
    - `ValidationService.ts`: runs, single flight, rights, and the standing lookup;
    - `validationTools.ts`.
  - `durable-plans`' `PlanService.approve` gains a pre-transaction read for `validation-current`, and the plan connections gain the new human actions and pushes.
  - `teamPrompt.ts`: the plan note gains validation.
- **Shared.** New `src/shared/planValidation.ts`: the report types, finding keys, relation derivation, and readiness as pure functions. `src/shared/types.ts` gains the new messages, which must also be listed in `CHAT_CONNECTION_TYPES`.
- **Client.** `PlanValidationSection.tsx` with its dialogs, mounted in the Plans view's revision section, and plan-store wiring.
- **Data.** An additive migration with three new tables. No backfill: existing revisions start as Not validated.
- **Docs.** AGENTS.md How It Works bullets for validation, alignment, and the tools.
- **Tests.**
  - Unit coverage of identity, every check, relations, readiness, decisions, the sticky conflict, dry runs, single flight, the precondition (with `durable-plans` approval), cross-team refusals, and persistence.
  - The adapter is tested against a stub CLI.
  - One browser walkthrough, named in `.github/workflows/ci.yml`.
- **Sequencing.**
  - Implement after `durable-plans` (contracts C1, C2, and C4) and `strategy-revision-impact` (C-I1 and C-I2).
  - `plan-execution` follows and binds to this change's contracts (design D12).
