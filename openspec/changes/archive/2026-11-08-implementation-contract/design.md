# Design

## Context

See proposal.md (Why) for the motivation. The current state this design
builds on:

- **Task revisions.** `team_task_revisions` (`src/server/team/taskRevisionSchema.ts`)
  stores `direction`, `acceptance`, author, time, and the publication's
  rationale, command key, and notify flag. Drafts live in `team_task_drafts`.
  Publication compares the replayed payload field by field
  (`taskPayloadDiff.ts`). `task_create` and `task_amend`
  (`src/server/team/taskTools.ts`) take `direction` and `acceptance` as
  strings.
- **Task context.** The delivered task header is built at delivery
  (`taskContext.ts`). It carries the direction whole and bounds only the
  journal.
- **Execution tasks.** `executionDispatch.ts` creates each change's task
  with a fixed direction sentence plus the plan's guidance, and the plan's
  acceptance lines. The change's worktree is provisioned at
  `changeRow.baselineCommit`, which Start guarantees equals the validated
  base content ("Changes start from artifacts on the base branch").
- **Validation.** `validationChecks.ts` holds `VALIDATION_CHECKS`. The input
  hash already covers every change's artifact digests and
  `VALIDATION_CHECKS_VERSION` (now 1), so a check that reads `design.md`
  adds no new input.
- **Result checks.** `src/server/verification/resultChecks.ts` computes
  `ResultCheckFacts` (`version: 1`) from read-only git at the team's main
  checkout. Client readers test `facts.version === 1`
  (`CoverageMapView.tsx`).
- **Hashing.** `canonicalJson` (`src/shared/productStrategy.ts`) sorts
  object keys and keeps array order. Plans and validation inputs already
  hash with it.

## Goals / Non-Goals

**Goals:**

- One contract grammar, parsed by one pure shared module that the server,
  the client's live editor, plan validation, and execution all use.
- A hash that changes exactly when the contract's meaning-bearing content
  changes: ids, text, order, globs.
- A contract changes only by publishing a revision. Nothing ever re-derives
  it from files after creation.
- No change to how acknowledgement, attempt manifests, or the
  re-evaluation path work.

**Non-Goals:**

- Findings that cite clauses, the gate, the ledger, and rebuttals
  (`review-findings-ledger`).
- Convergence signals and the DIAGNOSE card (`review-convergence`).
- Enforcing scope. The scope fact is evidence, never a gate.
- Semantic checks of clause text (whether a clause is testable or
  well-written). That stays with the architect and the reviewers.
- A contract for subtasks inherited from a parent. Each task carries its
  own or none.

## Decisions

### D1 — One Markdown grammar, one shared parser

The contract is always written as the `## Implementation contract` section:
in `design.md`, in `task_create`/`task_amend`'s `contract` string, and in
the task form's textarea. `src/shared/implementationContract.ts` exports:

- `parseContract(text)`, which returns `{ contract, problems }`;
- `locateContractSection(markdown)`, which finds the section inside a
  whole `design.md`;
- `renderContract(contract)`;
- `contractHashInput(contract)` and `textIdentityInput(direction, acceptance)`,
  the canonical sha256 inputs;
- `revisionIdentity(revision, hash)` and `clauseIdentity(identity, id)`.

The sha256 itself lives on the server, in `src/server/team/contractHash.ts`
(`contractHash`, `textHash`, `identityOf`), like `planHash.ts`: shared
modules stay free of `node:crypto`, and the client never needs a hash, only
the identities the server sends.

The parser is line-based and pure, with no Markdown library (no new
dependency):

- The section starts at the first `## Implementation contract` line
  **outside fenced code blocks** (``` or ~~~). It ends at the next `## `
  heading outside fences, or at the end of the file. A second such heading
  is a problem. Fences matter because a design (this one included) may
  show an example contract inside a code block.
- The `###` part headings are matched case-sensitively after trimming.
  They must all be present and appear in the fixed order.
- In a clause part, a bullet `- <ID>: <text>` matches
  `^- ([AIVX])([1-9][0-9]*): (.+)$`. The letter must match the part. A
  following line indented by at least two spaces continues the clause; its
  trimmed text is appended after one space.
- In Scope, a bullet `- <glob>` holds one glob. A glob may be written in
  backticks, and they are stripped.
- Blank lines are ignored. Any other line inside the section is a problem.
  Every problem carries its 1-based line number, counted in the input text.
  For `design.md` that is the line number in the file.

**Alternative considered:** a JSON tool parameter plus a Markdown section
for designs. Rejected because it means two grammars, two validators, and
agents that write Markdown well being forced into JSON for one field.

### D2 — Normal form and hash

The parsed contract is
`{ version: 1, acceptance: Clause[], invariants: Clause[], scope: string[], verification: Clause[], excluded: Clause[] }`,
where `Clause = { id, text }`. Order is kept as written, because order is
meaningful to readers and a reorder is a deliberate edit. Clause text is the
bullet text with continuation lines joined by single spaces, each trimmed.
Internal runs of spaces are kept. The hash is
`sha256(canonicalJson(contract))`, in hex. Line endings, trailing spaces,
blank lines, and backticks around globs never reach the normal form, so they
never change the hash.

The text identity of a revision without a contract is
`sha256(canonicalJson({ kind: 'text', direction, acceptance }))`. It is
computed on read and never stored, so old rows need no backfill.

`renderContract` emits the canonical Markdown: the headings, one bullet
per clause, no continuation lines, and globs in backticks. The editor
pre-fills drafts with it, and it round-trips through the parser (P2).

### D3 — Storage and carry-forward

A numbered migration (the next free number when the PR lands; coordinate
with in-flight migrations, as `lead.md` requires) adds:

- `team_task_revisions.contract TEXT` (the normal form's JSON) and
  `team_task_revisions.contract_hash TEXT`. Both are null for a revision
  without a contract.
- `team_task_drafts.contract_text TEXT`, which holds raw, possibly
  unparsed text, so a half-edited draft survives restart.

`TaskService` resolves a revision's contract inside the publication
transaction:

| | Previous revision | Input | New revision |
|---|---|---|---|
| C1 | none | omitted | none |
| C2 | none | parses | the input |
| C3 | has one | omitted | previous, same hash |
| C4 | has one | parses | the input |
| C5 | * | does not parse | refused with problems, nothing written |
| C6 | has one | explicitly cleared (draft text empty) | refused naming the contract, draft kept |
| C7 | none | explicitly cleared | none |

The tools cannot express "cleared": `contract` is an optional string, and
an empty string counts as omitted. Only the human's draft can clear, which
is why C6 exists.

The publication payload diff compares `contract_hash`, so a replay with an
edited contract under the same key is refused naming `contract`.
Revision 1 is resolved the same way, with "previous" taken as none.

### D4 — Execution snapshots the contract once

In `executionDispatch.ts`, before `tasks.create`, Kawai runs
`git show <baselineCommit>:openspec/changes/<change>/design.md` in the
change's worktree, applies `locateContractSection`, then `parseContract`:

| | `design.md` at baseline | Section | Task revision 1 | Journal |
|---|---|---|---|---|
| E1 | present | parses | carries the contract | — |
| E2 | present | missing | no contract | "no Implementation contract section in design.md at <sha7>" |
| E3 | present | does not parse | no contract | the first 5 problems with lines, and the count |
| E4 | missing | — | no contract | "design.md missing at <sha7>" |
| E5 | git show fails (timeout, spawn) | — | no contract | the failure |

E2–E5 never stop the change. Validation already refuses them for any
execution started after this change (D5). Only an execution started before
the upgrade, or a race that validation cannot see, reaches them. Stopping
would turn a missing contract into a dead change.

The instruction text names `r1#<hash12>`, or "no contract". The attempt
manifest is unchanged, because it already pins the task revision, and the
revision fixes the contract. Later edits to `design.md` anywhere are never
read again for this task.

**Alternative considered:** re-deriving on every new revision. Rejected
because it makes file edits change the contract, which is exactly what the
proposal rules out. The human edits the contract in the published revision
instead.

### D5 — Validation check `implementation-contract`

This is a new entry in `VALIDATION_CHECKS`. It runs after `change-registered`
and skips changes that are not registered, like the other CLI-reading
checks. It reports under the `intent` row. It reads `design.md` from the
change's resolved directory, which the input hash already digests. It
produces one error per change, carrying all problems, or evidence with the
hash. `VALIDATION_CHECKS_VERSION` becomes 2, so every earlier report reads
Out of date (the spec's BREAKING item).

### D6 — The scope fact

`ResultCheckFacts` stays `version: 1` and gains an optional
`scope?: { status, withinScope, outside: string[], more, contractIdentity, note }`.
Readers treat an absent field as "not checked", which covers rows written
before this change. Bumping the version was rejected because readers gate
on `version === 1` and would drop every other fact.

Computation, all read-only at the main checkout:

1. Take the contract of the result's pinned revision (`result.revision`).
   If there is none, the fact reads `status: 'no-contract'`.
2. Compute `git merge-base <base ref> <commit>`. If the commit or the base
   ref is unresolved, the fact is `unknown` with its reason, as for the
   other facts.
3. Run `git diff --name-status -z -M <merge-base> <commit>`. For a rename,
   both paths are judged, and the new path is listed when either one falls
   outside scope.
4. A path is in scope when `new Bun.Glob(g).match(path)` matches any glob,
   or when it starts with `openspec/changes/<linked change>/`. Bun.Glob
   runs only on the server. The grammar's character restrictions (D1) keep
   its brace, class, and negation features unreachable.
5. List at most 20 paths (`MAX_LISTED_PATHS`) and count the rest.

The fact shares the check's budget and its unavailable semantics.

### D7 — Reads and the header

`TaskRevision` and `TeamTask` gain
`contract: ImplementationContract | null`, `contractHash`, and
`identity: string` (the contract identity or the text identity). The
delivered header adds the identity line. When a contract exists it also
adds the rendered clauses and globs. Clauses are not truncated: they are
what reviewers cite, and the 16 KB contract bound keeps the header bounded.
`task_get` returns the same for every revision.

On the client:

- `TaskDirectionEditor.tsx` gains a contract textarea with live
  `parseContract` problems.
- `TaskPublications.tsx` (revision history) shows each revision's identity
  and contract.
- `TeamTaskDetail.tsx` shows the current one.
- The result card shows the scope fact.

### D8 — Prompts, docs, and the design rule

- **`openspec/config.yaml` `rules.design`:** add the required
  "Implementation contract" section, with the grammar summary and a
  pointer to `docs/agent-collaboration.md`.
- **`docs/agent-collaboration.md`:** a new section, "Write the
  implementation contract". It covers:
  - who writes the contract: the architect, the Lead, or the Change Lead;
  - how to write clauses that a reviewer can judge pass or fail;
  - that scope lists what may change, not what will;
  - that excluded work is explicit;
  - that changes go through a published revision, never a branch edit.
- **`lead.md` and `change-leads.md`:** create code tasks with a contract,
  and amend it deliberately.
- **Dev role files:** work within scope. When a needed edit falls outside
  it, ask the task's creator for a revision; never widen scope silently.
  Cite clause ids in results.
- **`reviewers.md`:** cite clause identities (`r3#… › I2`). A request
  outside the contract is not blocking. This is the minimal hook. The full
  finding protocol arrives with `review-findings-ledger`.
- **`docs/architecture/`:** the tasks bullet.

The `.kawai/groups/*.md` files have uncommitted edits by the human in the
main checkout. The prompt PR must build on whatever the human has committed
by then and must never overwrite those edits.

## Acceptance oracles

### Parser — decision table (`parseContract`, `locateContractSection`)

| | Input | Contract | Problems |
|---|---|---|---|
| G1 | 5 headings in order; A1, I1, one glob, V1, no X | yes | none |
| G2 | Scope part empty | no | "Scope needs at least one glob" @ heading line |
| G3 | Acceptance or Verification empty | no | that part named @ its heading |
| G4 | Invariants and Excluded empty | yes | none |
| G5 | duplicate id A2 | no | "duplicate A2" @ second line |
| G6 | `- A3:` under Invariants | no | "A3 is not an Invariants id" @ line |
| G7 | headings out of order | no | the out-of-order heading @ line |
| G8 | a heading missing | no | the missing heading (line of the section start) |
| G9 | a plain paragraph inside a part | no | that line |
| G10 | a continuation line indented ≥ 2 | yes | none; text joined by one space |
| G11 | `- A0: x`, `- A01: x`, `- A1:` (empty text) | no | each @ its line |
| G12 | glob `../x`, `/etc/**`, `a\b`, `./a`, `!a`, `a[0]`, `{a,b}` | no | each glob named @ its line |
| G13 | glob in backticks | yes | none; backticks stripped |
| G14 | 51 clauses in one part; 41 globs; a 1,001-char clause; over 16,384 bytes | no | the limit named |
| G15 | section heading only inside a ``` or ~~~ fence | no section | "no Implementation contract section" |
| G16 | an example section in a fence and a real one after it | yes, the real one | none |
| G17 | two real section headings | no | the second @ its line |
| G18 | section followed by `## Risks` | yes | lines after `## Risks` ignored |
| G19 | several problems | no | all reported, sorted by line |
| G20 | CRLF input | as for LF | line numbers unchanged |

Unreachable: a contract together with problems. Every non-empty problem
list yields `contract: null`, which is the parser's return type invariant.

### Carry-forward — table C1–C7 (D3)

These rows are committed verbatim as a table-driven test through
`TaskService` against a real store: the agent path (`task_amend`) for C1–C5,
and the human publication path for C5–C7.

### Execution snapshot — table E1–E5 (D4)

Run through the production dispatch composition, never a hand-built
harness (hazard M1 in `docs/oracle-hazards.md`). E5 is injected through the
git adapter seam.

### Scope fact — decision table (D6)

| | Pinned revision | Commit / base | Changed paths | Fact |
|---|---|---|---|---|
| S1 | contract, scope `src/server/team/**` | resolves | `src/server/team/x.ts`, `openspec/changes/<c>/tasks.md` | within scope, none listed |
| S2 | same | resolves | + `src/client/App.tsx` | lists `src/client/App.tsx` |
| S3 | same | resolves | rename `src/server/team/a.ts` -> `src/shared/a.ts` | lists `src/shared/a.ts` |
| S4 | same | resolves | 25 out-of-scope paths | 20 listed, more = 5 |
| S5 | none | * | * | `no-contract` |
| S6 | contract | commit unresolved | — | unknown, reason |
| S7 | contract | base ref unset | — | unknown, reason |
| S8 | r2 narrow, r3 wide; result pinned r2 | resolves | a path only r3 covers | listed (r2 judged) |
| S9 | contract, scope `src/*.ts` | resolves | `src/a/b.ts` | listed (`*` does not cross `/`) |
| S10 | contract | resolves | `openspec/changes/<other>/design.md` | listed (only the linked change is exempt) |

### Validation — decision table (D5)

| | Change | `design.md` section | `implementation-contract` |
|---|---|---|---|
| V1 | registered | parses | evidence: hash |
| V2 | registered | missing (or no `design.md`) | error naming the change |
| V3 | registered | malformed | one error, all problems with lines |
| V4 | not registered / archived | * | nothing (`change-registered` blocks) |
| V5 | report from checks version 1 | * | standing Out of date, naming the checks version |

### Properties

All properties run with seed `0x1C0A7AC7` and 500 cases. Generators are
built from `src/shared/__tests__` helpers with a seeded PRNG; no new
dependency.

- **P1 — formatting invariance.** For a generated valid contract `c`, apply
  any mix of CRLF line endings, trailing spaces, blank lines between
  bullets, backticked globs, and continuation splits at spaces. Then
  `contractHash(parse(variant)) == contractHash(c)`.
  The seam is the pure parser and hash.
- **P2 — round trip.** `parse(renderContract(c)).contract` deep-equals `c`,
  with no problems.
- **P3 — content sensitivity.** Changing one clause's text by a
  non-whitespace character, one id, the order of two clauses, or one glob
  changes the hash.
- **P4 — revision isolation.** Over a seeded sequence of `task_amend`
  calls (omitted, valid, or malformed contract) and human publications
  (including clears), every stored revision's `contract_hash` equals
  `contractHash(contract)`, earlier revisions never change, and a refusal
  writes no revision row. The seam is `TaskService` over a real SQLite
  store.

Consulted `docs/oracle-hazards.md`. M1 shapes E1–E5 and the scope rows,
which run through the production composition. The cache-key hazard does
not apply, because no cache is added.

## Implementation contract

### Acceptance
- A1: The shared parser, renderer, hash, and identity functions implement
  the implementation-contract spec, with rows G1-G20 and properties P1-P3
  passing.
- A2: Task creation, amendment, drafts, and publication carry, replace,
  and refuse contracts per rows C1-C7 and property P4.
- A3: Execution task creation snapshots the contract per rows E1-E5,
  through the production dispatch.
- A4: Plan validation reports `implementation-contract` per rows V1-V5,
  and the checks version is 2.
- A5: Result checks record the scope fact per rows S1-S10 without gating.
- A6: The task header, `task_get`, the task detail, the revision history,
  and the result card show the contract identity and contract.
- A7: The role files, `docs/agent-collaboration.md`, the
  `openspec/config.yaml` design rule, and the architecture bullet describe
  the contract.

### Invariants
- I1: Nothing re-derives a task's contract from files after the task is
  created; only a published revision changes it.
- I2: A revision row's contract and hash never change after it is written.
- I3: Result checks never block, gate, or change acceptance, handoffs,
  findings, or task status.
- I4: Existing rows and older result facts keep reading; no backfill
  rewrites them.
- I5: No new runtime dependency.

### Scope
- `src/shared/**`
- `src/server/team/**`
- `src/server/verification/**`
- `src/server/plans/execution/**`
- `src/server/plans/validation/**`
- `src/server/dbSafety/migrations.ts`
- `src/server/__tests__/**`
- `src/client/components/team/**`
- `src/client/stores/**`
- `.kawai/groups/**`
- `docs/**`
- `openspec/config.yaml`
- `e2e/**`

### Verification
- V1: `bun run check` passes on the clean committed tree.
- V2: Every row and property above is committed as a named test, and each
  test title cites its oracle id.
- V3: Every ADDED or MODIFIED scenario has an `@covers` annotation.
- V4: A Playwright walkthrough shows a contract being edited, published,
  and displayed in the revision history.

### Excluded
- X1: Finding schema, finding gate, rebuttals, and the findings ledger
  (`review-findings-ledger`).
- X2: Convergence signals, the DIAGNOSE card, and changes to the
  three-failed-fix-rounds stop (`review-convergence`).
- X3: Any change to attempt manifests, acknowledgement, or the
  revision re-evaluation path.

## Risks / Trade-offs

- [The BREAKING validation bump strands approved, unstarted plans] → The
  proposal and release notes name it. The error names each change and the
  missing section. Adding a section is a docs edit that re-validation picks
  up.
- [Architects write vague clauses, so citations stay judgment calls] →
  The prompts give pass/fail examples. `review-findings-ledger` lets
  reviewers flag an untestable clause. This change does not try to judge
  clause quality.
- [Scope globs that are too narrow make the scope fact noisy] → The fact
  never gates, and the linked change's own directory is exempt. The dev
  prompt routes a needed widening through a revision.
- [Header growth: up to 16 KB of contract in every task mail] → Typical
  contracts are 1–3 KB. The bound caps the worst case. If needed, a later
  change can switch the header to identity-only plus `task_get`.
- [A fenced example in a design confuses the parser] → Fence-aware
  location (G15–G17).
- [Migration number collides with an in-flight change] → Take the next
  free number at implementation time and coordinate through the Lead.

## Migration Plan

1. Ship the migration (additive nullable columns). No backfill is needed:
   text identities are computed on read.
2. Ship the shared model, tasks, and the scope fact. Existing tasks read as
   having no contract, and nothing else changes.
3. Ship the validation check together with the checks-version bump, and
   announce it: approved, unstarted plans need re-validation and their
   changes need the section. Running executions continue.
4. Ship the prompts and the design rule last, once the tools accept
   `contract`.

Rollback: the columns are nullable and unread by older builds. Reverting the
validation check restores version 1, and reports produced under version 2
then read Out of date and are re-validated.
