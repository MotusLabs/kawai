# Tasks

Every Verify clause cites its oracle ids (design.md, "Acceptance oracles")
and names the mutant each must kill. Tables are committed verbatim as
table-driven tests next to the code they cover. Each test title starts
with its row or property id. The result maps each oracle id to a test
title (`` `file` › `exact title` ``) and a killed mutant. Each test that
covers a spec scenario carries its `// @covers:` annotation.

## 1. Shared contract model

- [x] 1.1 Add `src/shared/implementationContract.ts`:
  - `ImplementationContract` and `Clause` types;
  - `locateContractSection` (fence-aware);
  - `parseContract`, returning problems with line numbers, the limits, and
    the glob character rules;
  - `renderContract`, `contractHash` (sha256 of `canonicalJson`),
    `contractIdentity`, and `textIdentity`.

  Commit table G1–G20 as `src/shared/__tests__/implementationContract.test.ts`.
  Verify: G1–G20 pass. Mutants to kill:
  - dropping the fence check (G15, G16);
  - accepting a part letter that does not match its part (G6);
  - accepting `A0` or a leading zero (G11);
  - letting `{` through (G12);
  - stopping at the first problem (G19);
  - an off-by-one limit (G14);
  - not ending the section at the next `## ` (G18).
- [x] 1.2 Add properties P1–P3 (seed `0x1C0A7AC7`, 500 cases) with a seeded
  generator of valid contracts and formatting variants. Verify: P1–P3 pass.
  Mutants to kill:
  - hashing the raw text instead of the normal form (P1);
  - a renderer that omits backticks or reorders clauses (P2);
  - trimming internal whitespace in clause text, or sorting clauses before
    hashing (P3).

## 2. Storage and task service

- [ ] 2.1 Add the numbered migration: `team_task_revisions.contract`,
  `contract_hash`, and `team_task_drafts.contract_text`, all nullable.
  Take the next free version and coordinate it through the Lead.
  Extend the schema tests (`taskRevisionSchema.test.ts`) so that a legacy
  database opens with existing rows unchanged. Verify: the migration test
  passes on a pre-migration fixture (I4). Mutant to kill: a NOT NULL column.
- [ ] 2.2 Resolve contracts in `TaskService` and the store, per table C1–C7:
  - create and `task_amend` take an optional contract string;
  - an empty string counts as omitted;
  - human drafts keep `contract_text`, and publication parses it;
  - the payload diff compares `contract_hash`.

  Commit C1–C7 as a table-driven test against a real store (agent path for
  C1–C5, human publication for C5–C7). Verify: C1–C7 pass, and the
  "Reused key with a different payload is refused" scenario names
  `contract`. Mutants to kill:
  - not carrying forward on omit (C3);
  - allowing a clear (C6);
  - writing a revision before parsing (C5);
  - leaving `contract_hash` out of the diff.
- [ ] 2.3 Add property P4 (seeded amendment/publication sequences, real
  SQLite). Verify: P4 passes (I2). Mutant to kill: an UPDATE of an earlier
  revision's contract during carry-forward.
- [ ] 2.4 Expose the contract in reads:
  - `TaskRevision` and `TeamTask` gain `contract`, `contractHash`, and
    `identity`;
  - `task_get` returns them per revision;
  - `buildTaskContext` adds the identity line and, when present, the
    rendered clauses and globs;
  - the `task_create`, `task_amend`, and `task_get` tool descriptions and
    zod schemas accept and describe `contract`.

  Verify: tests for the team-tasks scenarios "Contract in the header", "No
  contract in the header", "Lead creates a task with a contract", and
  "Malformed contract refused". Mutants to kill:
  - a header without clauses;
  - a legacy identity computed from direction only.
- [ ] 2.5 Update the tasks bullet in `docs/architecture/` (contract,
  identity, carry-forward). Verify: the bullet names the columns and the
  carry-forward rule.

## 3. Client

- [ ] 3.1 Change the task UI:
  - `TaskDirectionEditor.tsx`: a contract textarea, pre-filled with
    `renderContract` of the base revision, that shows live `parseContract`
    problems and disables Publish while any remain;
  - `TaskPublications.tsx`: each revision's identity and contract, or "no
    contract";
  - `TeamTaskDetail.tsx`: the current one;
  - the task-create form: an optional contract field.

  Verify: component tests for the "Revision history shows contracts" and
  "Draft contract survives restart unparsed" scenarios. Mutant to kill:
  Publish enabled with problems.
- [ ] 3.2 Verify in a real browser with Playwright (after `bun run build`):
  create a task with a contract, edit it in a draft, see a live problem,
  fix it, publish, and see both revisions' identities in the history (V4).
  Commit the spec under `e2e/`.

## 4. Execution snapshot

- [ ] 4.1 In `executionDispatch.ts`, before `tasks.create`, read
  `openspec/changes/<change>/design.md` at `baselineCommit` with `git show`
  through the existing git seam, then locate and parse the section. Pass
  the contract to create, or journal the reason per table E1–E5. Name the
  identity, or "no contract", in `implementInstruction`. Commit E1–E5
  through the production dispatch composition (hazard M1). E5 is injected
  at the git seam. Verify: E1–E5 and the plan-execution scenarios "The task
  carries the design's contract", "A change without a contract section",
  and "Design edited on the change branch". Mutants to kill:
  - reading the worktree HEAD instead of the baseline (E1, I1);
  - stopping the change on E2;
  - removing the create call's `contract` wiring (M1).

## 5. Plan validation

- [ ] 5.1 Add the `implementation-contract` check to `VALIDATION_CHECKS`
  (row `intent`, skipping changes that are not registered), and raise
  `VALIDATION_CHECKS_VERSION` to 2. Commit V1–V5. Verify: V1–V5 and the
  plan-validation scenarios, including "A running execution is
  unaffected". Mutants to kill:
  - checking unregistered changes (V4);
  - not bumping the version (V5);
  - stopping at the first problem (V3).
- [ ] 5.2 Update the plan validation bullet in `docs/architecture/` and the
  Plans view's check label, if the row lists checks by name. Verify: the
  label renders in the existing validation section test.

## 6. Scope fact

- [ ] 6.1 Add `scope?` to `ResultCheckFacts` (still `version: 1`) and
  compute it in `resultChecks.ts` per D6: the pinned revision's contract,
  the merge base, `diff --name-status -z -M`, `Bun.Glob`, the
  linked-change exemption, and the 20-path cap. Commit S1–S10 against a
  real temporary repository. Verify: S1–S10, the task-results scope
  scenarios, and "Outside scope does not gate" (I3). Mutants to kill:
  - judging only a rename's new path (S3);
  - using the task's current revision (S8);
  - exempting every `openspec/changes/**` path (S10);
  - `**` semantics for `*` (S9).
- [ ] 6.2 Show the scope fact on `TaskResultCard.tsx` ("within scope", the
  listed paths with the count, "no contract", or "not checked" for older
  facts). Verify: a component test over those four states. Mutant to kill:
  treating an absent `scope` as within scope.

## 7. Prompts, docs, and the design rule

- [ ] 7.1 Add the section "Write the implementation contract" to
  `docs/agent-collaboration.md`, covering:
  - who writes it;
  - clauses a reviewer can judge pass or fail, with examples;
  - that scope lists what may change;
  - that exclusions are explicit;
  - that changes come only through a published revision.

  Add the required section to `openspec/config.yaml` `rules.design`.
  Verify: `openspec instructions design --change <any> --json` shows the
  new rule, and the section's example contract parses with
  `parseContract` (a test that reads the doc declares it with `@reads`).
- [ ] 7.2 Update `.kawai/groups/lead.md`, `change-leads.md`, the dev role
  files, and `reviewers.md` (plus `reviewers-glm.md` if it is committed by
  then) per D8, building on the human's committed edits and never
  overwriting uncommitted ones. Verify:
  - `git diff` touches only the D8 paragraphs;
  - each file stays within its current size plus 1.5 KB;
  - a reviewer reads the files for conflicts with the existing blocking
    and oracle rules.

## 8. Integration

- [ ] 8.1 Run `bun run check` on the clean committed tree (V1). Confirm
  that every ADDED or MODIFIED scenario has an `@covers` annotation (V3),
  and that the result's map ties each oracle id G1–G20, C1–C7, E1–E5,
  V1–V5, S1–S10, and P1–P4 to a test title and a killed mutant (V2).

## Workflow follow-up

- Write `review-findings-ledger` against this change's clause identities
  (proposal on branch `docs/review-findings-ledger`).
- Write `review-convergence` over that ledger (proposal on branch
  `docs/review-convergence`), resolving its open problem: who may publish
  a contract amendment that DIAGNOSE decides for a Kawai-created task.
- Archive after review, adding `@covers` annotations for every scenario
  left in the main specs.
