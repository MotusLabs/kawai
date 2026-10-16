# Design

## Context

See proposal.md (Why). This change binds to contracts that are already published:
- **`durable-plans`.**
  - C1 `PlanContent`: changes, `dependsOn`, groups, roles, landing.
  - C2: the strategy pin, and the `openPlans(teamId)` read.
  - C4: the ordered `APPROVAL_PRECONDITIONS`, whose entries are `{ name, check(ctx) → string | null }` and run inside one SQLite transaction. D7 reserves `validation-current` for this change. C4 names the precondition list and `pinDisposition` as its extension points, but no pre-transaction gather. D9 adds one that feeds `ctx.validation` only. The `durable-plans` implementation is asked to leave an empty awaited step in `PlanService.approve` for it; where it has not, tasks 8.1 adds the await.
  - D3 keeps environment checks, artifact pins, and typed relations out of plan content.
- **`strategy-revision-impact`.**
  - C-I1 `ImpactService.gate(planId, revision)`.
  - C-I2 `ImpactService.stateKey(planId)`, which is named as this change's input identity.

Code facts this design relies on:
- **OpenSpec CLI.** `src/server/workspace/openspecDiscovery.ts` runs only `openspec list --json`, with a 15 s timeout. Nothing on the server runs `openspec validate` or `openspec show`. The installed CLI, 1.14.1, supports `validate <change> --strict --json`, which reports per-item `valid` and `issues`. It also supports `show <change> --json --deltas-only`, which gives deltas as `{ spec, operation, description, requirement?, requirements?, rename? }` (`change.schema.js`). ADDED, MODIFIED, and REMOVED deltas name their requirement in `requirement.name`. A RENAMED delta carries `rename: { from, to }` and no `requirement`.
- **Change registry.** `changeRegistry.ts` lists the unarchived changes from the main worktree's OpenSpec root. The convention worktree `<main>/.worktrees/<change>` is canonical once it exists and contains the change.
- **Group and profile catalogs.**
  - `groupCatalog.ts` has `loadGroupCatalog`. Its `groupCatalogStamp` is mtime-based, so it is a change detector, not a content identity.
  - Profiles come from `src/server/chat/profileCatalog.ts`.
- **Capacity reads.** `staffing.ts` `capacity()` and `routing/limitEvents.ts` `cooldownUntil` already answer caps and cooling.
- **Hashing.** `canonicalJson` (`src/shared/productStrategy.ts`) is the hashing serializer that `durable-plans` reuses.

### Reconciliation with the merged code (task 1.1)

Names verified against master 5cc1690; no rename changes a contract above, and the facts below fix the concrete spellings this implementation uses:

- `PlanContent`, `PlanStrategyPin` (`src/shared/plans.ts`), and `PlanStore.openPlans(teamId)` (`src/server/plans/planStore.ts`) are the merged spellings of C1/C2; the pin is `PlanRevision.pin: PlanStrategyPin | null`.
- `APPROVAL_PRECONDITIONS` lives in `src/server/plans/planPreconditions.ts`. Its ctx is `ApprovalContext`, built in one place by `buildApprovalContext(deps, prepared, plan, request)`; the pre-transaction gather D9 adds is the shipped seam `prepareApproval(deps, plan, request): Promise<ApprovalPrepared>` (empty today), already awaited in `PlanService.approve`. Extending it keeps the shipped entries untouched and must short-circuit a command id that already stands (the seam's own comment). `PlanService` also takes a `preconditions` option that overrides the list wholesale (tests pin it); the append point is the default the service uses, which becomes the shipped list plus `validation-current` last.
- The plan-change notification is `PlanStore.subscribe`/`announce(planId)` feeding `onPlanChange(teamId, planId?)` in `ChatSessionManager` and `PlanConnections.publish`; validation, assessment, and decision pushes ride the same path (D11).
- `team-plan-result` is the `PlanServerMessage` member in `src/shared/planMessages.ts`; D11's additive fields extend it.
- `ImpactService.gate(planId, revision)` and `stateKey(planId)` exist verbatim (`src/server/strategy/ImpactService.ts`, contracts C-I1/C-I2); `ImpactGate` is `{ state, pass, reviewId, decisionId, pin }` and `stateKey` hashes the plan's `approved`/`in_review` revisions' gates.
- The pinned revision's ref set (D5) is `strategyAlignmentRefs(content)` in `src/shared/planChecks.ts`, the same set `PlanService.submit` checks alignment refs against.
- Schema changes go through `MIGRATIONS` in `src/server/dbSafety/migrations.ts` (versions dense from 2; master holds 2 `strategy-impact`). The three tables register as migration `plan-validation`, version 3 provisionally — renumbered if `outbound-audit` lands first.
- Change resolution uses `discoverRepository(commonDir)` (`src/server/git/worktreeList.ts`) plus `resolveChangeRegistry` and `conventionWorktreePath` (`src/server/workspace/changeRegistry.ts`); catalogs are `loadGroupCatalog`/`groupCatalogStamp` (`src/server/team/groupCatalog.ts`) and `resolveProfileCatalog` (`src/server/chat/profileCatalog.ts`); capacity is `WorktreeStaffing.capacity(teamId, groupId, worktree)` and cooling is `LimitEventStore` with `cooldownUntil(events, now)` (`src/server/team/routing/limitEvents.ts`).
- Agent tool names join `TEAM_ALLOWED_TOOLS` through a name list in `src/server/team/mailboxTools.ts` (as `PLAN_TOOL_NAMES` does); new client message types join the explicit `CHAT_CONNECTION_TYPES` list in `src/server/chat/chatConnectionTypes.ts` (the `team-plan${string}` extraction prefix already exists).
- The installed OpenSpec CLI is 1.14.2 (floor 1.14); CI installs 1.12.0, so no test may depend on a real CLI — the adapter tests and the walkthrough use a stub executable, and a below-floor or missing CLI is itself a check outcome.

## Goals / Non-Goals

**Goals:**
- One input identity, computed the same way at validation, at approval, and later at Start.
- Reports are immutable snapshots, and readiness is a pure function of what a report holds.
- Mechanical checks never depend on model judgment. Judgment is recorded with its author and can never clear a mechanical error.
- `validation-current` stays a synchronous check inside `durable-plans`' approval transaction.

**Non-Goals** (beyond the proposal's):
- a generic check-runner framework. The checks are a constant list, like `APPROVAL_PRECONDITIONS`.
- file watchers that keep standing live. Standing is computed on read, because watchers miss events when inotify is exhausted.
- storing full CLI output. Issues are kept, capped at 50 per change, with a count.

## Decisions

### D1. A `src/server/plans/validation/` module with three tables

The files are:
- `validationSchema.ts` and `validationStore.ts`;
- `openspecAdapter.ts` (D3);
- `validationInputs.ts` (D2);
- `validationChecks.ts` (D3, D4);
- `ValidationService.ts` (D6, D8, D9);
- `validationTools.ts` (D10).

Pure logic lives in `src/shared/planValidation.ts`, and every file stays under 500 LOC. The tables:

```sql
plan_validation_reports (
  id TEXT PRIMARY KEY,                 -- 'pvr-<uuid>'
  plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
  seq INTEGER NOT NULL,                -- per revision, from 1; the newest report is max(seq)
  input_hash TEXT NOT NULL,
  inputs_json TEXT NOT NULL,           -- ValidationInputs (D2)
  findings_json TEXT NOT NULL,         -- Finding[] (D3–D5)
  relations_json TEXT NOT NULL,        -- PlanRelation[] (D4)
  evidence_json TEXT NOT NULL,         -- locations, baseline commits, capacity, capped CLI issues
  readiness_json TEXT NOT NULL,        -- Readiness (D7)
  ready INTEGER NOT NULL,
  requested_kind TEXT NOT NULL,        -- 'human' | 'agent'
  requested_session TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, revision, seq)
);

plan_assessments (
  id TEXT PRIMARY KEY,                 -- 'pas-<uuid>'
  plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- 'alignment' | 'question' | 'finding' (D5)
  payload_json TEXT NOT NULL,
  author_kind TEXT NOT NULL,           -- 'human' | 'agent'
  author_session TEXT,
  command_id TEXT,                     -- the owner's form; null for agent tool calls (NULLs never collide)
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX plan_assessments_revision ON plan_assessments (plan_id, revision, created_at);

plan_validation_decisions (
  id TEXT PRIMARY KEY,                 -- 'pvd-<uuid>'
  plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- answer | accept-warning | resolve-condition
                                       -- | alignment-exception | authorize-exploration (D6)
  target TEXT NOT NULL,                -- question id, warning key, '<assessment id>#<n>', or assessment id
  text TEXT NOT NULL,                  -- the answer or the rationale
  scope TEXT,                          -- the bounds of an exception or an exploration
  actor_kind TEXT NOT NULL,            -- always 'human' in this change
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,          -- compared on replay
  created_at TEXT NOT NULL,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX plan_validation_decisions_revision ON plan_validation_decisions (plan_id, revision, created_at);
```

All three tables are append-only. A report is never updated, and a later decision on the same kind and target supersedes the earlier one while both stay readable.

*Alternative:* store validation in `plan_events`. Rejected: reports are large and queried by revision, and C6 lets later changes add event kinds, not payload tables.

### D2. Inputs and identity

```ts
type ValidationInputs = {
  checksVersion: number                          // VALIDATION_CHECKS_VERSION, bumped when a check's logic changes
  plan: { planId: string; revision: number; contentHash: string }   // the hash binds the strategy pin (durable-plans D2)
  impactStateKey: string                         // C-I2
  adapter: { tool: 'openspec'; version: string | null; capabilities: string[] }
  changes: Array<{                               // in plan order
    change: string
    status: 'registered' | 'unregistered' | 'archived' | 'missing'
    artifacts: Record<string, string>            // relative path → sha256: proposal.md, design.md, tasks.md, specs/**/spec.md
    baseSpecs: Record<string, string | null>     // capability path → sha256 of openspec/specs/<path>/spec.md, null if absent
    config: string | null                        // sha256 of the root's openspec/config.yaml (else config.yml), null if absent
  }>
  catalog: { groups: Record<string, string | null>; profiles: string }  // named groups' parsed-definition digests; digest of known profile ids
  claims: { branch: string[]; changes: Record<string, string[]> }      // other open plans' ids
  records: { assessments: string[]; decisions: string[] }              // ids of this revision's records, sorted
}
inputHash = sha256(canonicalJson(inputs))
```

`canonicalJson` sorts object keys but keeps array order, so every array except `changes` is sorted before hashing: `adapter.capabilities`, `claims.branch`, each list in `claims.changes`, and both `records` lists. `changes` keeps plan order, which the revision's content already fixes. The same claims and records therefore hash the same way whatever order `openPlans` or the store returns them in.

The inputs come from two places:
- **File-held:** `adapter`, `changes`, and `catalog`. These are read without a transaction or the CLI, except the adapter probe, which is cached for ten minutes.
  - A change's artifacts are hashed where it resolves (D3).
  - The capability paths for `baseSpecs` come from the change's own `specs/**/spec.md` paths, not from the CLI. So identity can be recomputed without running `openspec`.
- **DB-held:** everything else, read inside a transaction.

Only content enters the identity:
- The change's location (main checkout or convention worktree) is evidence. A proposal that moves from a worktree into the main checkout with unchanged content leaves the report current.
- The repository baseline commit (each root's `HEAD`) is evidence too.

The CLI's verdicts depend only on the artifacts, the base specs, the root's OpenSpec config (which selects the schema), and the CLI version. So a stored verdict stays valid for as long as the identity holds.

*Alternative:* put the main checkout's `HEAD` in the identity. Rejected: master moves with every merge, including the plan's own landed changes. Every report would go stale within minutes in an active team, and the owner would learn to click through revalidation, which defeats the gate. A baseline change still invalidates a report whenever it changes a file the checks read (R06). `plan-execution` records the baseline it actually builds on.

### D3. The technical checks and the adapter

`validationChecks.ts` exports `VALIDATION_CHECKS`, a constant ordered list of entries. Each entry is `{ name, row, run(ctx) → Finding[] }`, where `row` names the UX doc row it reports under.

```ts
type Finding = {
  check: string
  key: string                      // `${check}:${subject}`, stable within a revision
  severity: 'error' | 'warning' | 'evidence'
  row: 'alignment' | 'intent' | 'scope' | 'readiness'
  subject: string                  // a change, group, profile, branch, pair, or capability
  message: string
  detail?: unknown                 // bounded; CLI issues are capped at 50 per change
}
```

| Check | Row | Error | Warning | Evidence |
| --- | --- | --- | --- | --- |
| `adapter-available` | readiness | CLI missing, version unparsable or below the supported floor (1.14), or a capability probe failed | — | version, capabilities |
| `change-registered` | scope | missing; archived (names the archive directory); present only in a worktree outside the registry (names it) | — | canonical location and its `HEAD` |
| `openspec-valid` | intent | `validate --strict` reports the change invalid (issues attached), or the call failed or timed out | — | — |
| `relations` | scope | conflict (D4) | overlap (D4) | serialized pairs |
| `change-claimed-elsewhere` | scope | — | another open plan's `in_review` or `approved` revision names the change | — |
| `strategy-impact` | alignment | C-I1 gate does not pass (the state is named) | — | gate state |
| `groups-known` | readiness | a role, change, or review group is not in the team's catalog | — | — |
| `profiles-known` | readiness | a role profile is not a known profile | the group declares `profiles` and the role profile is not among them (only a *known* profile warns — an unknown one already errors, and keys never collide across severities) | — |
| `branch-free` | readiness | another open plan's `in_review` or `approved` revision lands on the same integration branch | — | whether the branch exists, its head, its worktree |
| `capacity` | readiness | — | — | per role group: caps, live members, cooling profiles with their cooldown end |

Rules:
- **Resolution.** Change resolution reads fresh state: `discoverRepository` for the worktrees, `changeRegistry`'s canonical rule applied to that state, and `openspec/changes/archive/*-<name>` for archives. Discovery's last snapshot is not used, because it may lag.
- **Missing operations.** A missing operation never yields success. When the adapter is unavailable, `openspec-valid` and `relations` each report one error ("not checked: OpenSpec adapter unavailable").
- **Unresolved changes.** A change that is not `registered` is skipped by `openspec-valid` and `relations`, because its `change-registered` error already blocks.
- **CLI calls.** They run in the change's canonical root, with the discovery timeout (15 s) and at most four at once. A timeout is an error for that change.
- **The adapter** (`openspecAdapter.ts`) is the only module that spawns the CLI for validation:
  - `probe()` runs `openspec --version` and returns the version and the capability names `validate-strict-json` and `show-deltas-json`, granted from the supported version floor.
  - `validate(root, change)` and `showDeltas(root, change)` normalize the JSON. `showDeltas` returns `(capability, operation, requirement)` touches. It expands one RENAMED delta (`rename: { from, to }`) into two touches, one per name, before D4 pairs them.
  - Unknown shapes are errors, including a RENAMED delta without both names and any other delta without `requirement.name`.

### D4. Typed relations from spec deltas

For each change, the adapter's deltas give `(capability, operation, requirement)` triples. For every unordered pair of the plan's changes:
- `ordered(a, b)` holds when either reaches the other through `dependsOn`, transitively. The graph is acyclic (`durable-plans` D3).
- If both touch the same `(capability, requirement)`, whatever the operations, the pair conflicts:
  - unordered, it is an **error**, keyed `relations:conflict:<a>+<b>:<capability>/<requirement>` (R04: conflicting changes prevent Ready without any cycle);
  - ordered, it is a `serialized` relation, recorded as evidence.
- If both touch the same capability but no shared requirement, the pair overlaps:
  - unordered, it is an `overlap` relation;
  - ordered, it is `serialized`.
- A capability's unordered overlap pairs raise one **warning**, keyed `relations:overlap:<changes>:<capability>`. `<changes>` is the sorted set of changes in those pairs, joined by `+`. The warning's detail lists the pairs, and the per-pair rows stay in `relations_json`.
  - One warning per capability means one owner acceptance. Pairwise warnings would need C(N,2) acceptances for N changes on one capability, while the overlap stays advisory and the conflict error is what enforces R04.
  - The change set is part of the key. If an artifact edit makes another change of the revision touch that capability, the next report raises a new key. An earlier acceptance therefore never covers a change it did not name.

```ts
type PlanRelation = {
  kind: 'conflict' | 'overlap' | 'serialized'
  changes: [string, string]           // sorted
  capability: string
  requirements: string[]              // shared names; empty for an overlap
  order: [string, string] | null      // [earlier, later] when serialized
}
```

R04's resolution, "agreed serialization", is a `dependsOn` edge in a resubmitted revision.

`durable-plans` D3 gives a declared relation as its example: a UI change consuming an API change's contract. Declared relations need contract revisions, which do not exist and which strategy revision 2 does not ask for. This change therefore derives only the relations that the artifacts make mechanical.

*Alternative:* parse delta markdown in kawai. Rejected: the CLI is the authority on delta syntax, and its JSON is versioned with it through the adapter.

### D5. Assessments

Agents (`plan_assess`) and the owner (the assessment form) append records bound to a plan revision:

```ts
type AlignmentAssessment = {
  assessment: 'aligned' | 'aligned-with-conditions' | 'exploratory' | 'conflicting' | 'insufficient-information'
  outcomes: string[]                   // refs the pinned revision defines (durable-plans D6 step 4's ref set)
  conditions: Array<{ text: string; gate: 'ready' | 'start' | 'acceptance' }>
  experiment: { criteria: string; scope: string } | null
  conflicts: string[]                  // what the plan violates, in prose; boundaries carry no refs
  rationale: string
}
type Question = { text: string; mandatory: boolean; subject: string | null }   // subject: a change, or null
type AssessmentFinding = { text: string; subject: string | null }           // always a warning
```

Write rules (one transaction per call):
- **Target.** The plan is open, of the caller's team, and the revision is `in_review` or `approved`.
- **Empty pin.** An alignment assessment is refused when the revision's pin is empty: "no approved strategy: alignment is unassessed".
- **Shape.**
  - `aligned-with-conditions` needs at least one condition;
  - `exploratory` needs `experiment`;
  - `conflicting` needs at least one conflict;
  - the rationale must be non-empty;
  - every ref must be defined by the pinned revision.
- **Limits.** Every text field is at most 2,000 characters; longer text is refused, never cut. An agent call carries at most 20 questions and 20 findings.
- **Replay.** The owner's form (`team-plan-assess`, D11) records exactly one alignment assessment per command id and replays like D6. Questions and findings come only from agents. Agent calls carry no command id, so their rows have a null `command_id`, and a retried agent call appends again, as `strategy_impact_propose` does.

The newest alignment assessment is the effective one, except for D7's sticky conflict. Questions and findings accumulate. A question is keyed by its id, and a finding is a warning keyed `finding:<id>`.

Any team agent may assess. An assessment cannot clear an error, a question, a warning, or a recorded conflict (D7), and the owner approves with the assessment and its author shown.

*Alternative:* a `canAssessPlans` group right. Rejected for now: it would block the common case of the Lead assessing its own plan, and it would protect nothing that approval does not already guard.

### D6. Owner decisions

The human sends `team-plan-validation-decide { teamPath, planId, revision, kind, target, text, scope?, commandId }`. `ValidationService.decide` refuses an agent actor first. No agent tool exists either; the check is defense in depth, as `StrategyService` does it. Then, in one transaction:

1. **Replay.** Look up `(plan_id, command_id)`. With the same payload (`revision`, `kind`, `target`, `text`, `scope`), return the stored decision. Otherwise refuse, naming the first differing field. On any unique-constraint hit, roll back and run this step again (the `strategy-revision-impact` D4 pattern), so a constraint error never reaches the client raw.
2. **Revision.** The plan is open and the revision is `in_review` or `approved`.
3. **Target.** The target must suit the kind:
   - `answer`: a question of this revision;
   - `accept-warning`: a warning key raised by the revision's newest report;
   - `resolve-condition`: `<assessment id>#<n>`, a condition of an alignment assessment of this revision;
   - `alignment-exception`: a `conflicting` assessment of this revision, with `scope` required;
   - `authorize-exploration`: an `exploratory` or `insufficient-information` assessment of this revision, with `scope` required.
4. **Text.** The text must be non-empty after trimming and at most 2,000 characters, and the scope at most 500. Longer text is refused, never cut, because the owner's words are the record.
5. **Insert.**

The dialogs mint one command id when they open and re-mint it only when the compared payload changes (`durable-plans` D12).

### D7. Readiness, a pure function

`validationReadiness(findings, pin, assessments, decisions)` in `src/shared/planValidation.ts` returns:

```ts
type Readiness = {
  ready: boolean
  errors: string[]                     // finding keys
  unansweredQuestions: string[]        // mandatory question ids
  unacceptedWarnings: string[]         // check-warning and finding keys
  alignment: { state: 'unassessed' | 'passes' | 'blocked'; reason: string | null; effective: string | null }
  carriedConditions: Array<{ target: string; text: string; gate: 'start' | 'acceptance'; resolved: boolean }>
}
```

A warning counts as accepted when an `accept-warning` decision of the revision names its key.

The alignment standing applies these rules in order:
1. An empty pin is `unassessed`, and it passes (S11).
2. Any `conflicting` assessment of the revision without an `alignment-exception` targeting it is `blocked` ("conflict unresolved"). A later assessment does not lift it, whoever wrote it (S06).
3. No alignment assessment is `blocked` ("not assessed").
4. Otherwise the newest assessment decides:
   - `aligned` passes;
   - `aligned-with-conditions` passes when every `ready`-gated condition is resolved, and its `start` and `acceptance` conditions are carried;
   - `exploratory` and `insufficient-information` pass only with an `authorize-exploration` targeting that assessment;
   - `conflicting` passes once rule 2 is satisfied.

A report is `ready` when it has no errors, no unanswered mandatory questions, and no unaccepted warnings, and its alignment is `unassessed` or `passes`. The function is SDK-free, so the server stores its result and the client derives labels from the same code.

Assessments and decisions enter the identity (D2). One recorded after a report therefore makes that report out of date, and the owner validates again. The decide and assess results offer **Validate** in place.

*Alternative:* evaluate decisions live against the newest report. Rejected: a report would no longer be a snapshot of everything Ready rested on, and the Start comparison (R06) would need a second identity.

### D8. Running a validation

`ValidationService.validate(actor, { planId, revision } | { planId, draftId })` runs in phases:
1. **Scope.** The plan is the caller's team's and open. The revision is `in_review` or `approved`, or the draft exists (a dry run).
2. **Single flight.** One run per plan and revision (or draft). A concurrent request joins the running one.
3. **File phase** (async, no transaction):
   - the adapter probe;
   - change resolution;
   - artifact and base-spec digests;
   - `validate` and `showDeltas` per registered change;
   - catalog digests;
   - evidence: each root's `HEAD` and capacity.
4. **Record phase** (one SQLite transaction):
   - Re-read the revision, the impact gate and state key, the claims (C2 `openPlans`, excluding this plan), and the revision's records.
   - Compute the findings, relations, readiness, inputs, and hash.
   - If the newest report of the revision has the same input hash, return it and write nothing. Otherwise insert it with `seq = max + 1`.
5. **After commit.** Push the plan detail (D11).

A dry run goes through phases 1 to 4 and never inserts. It is computed as if submitted:
- `strategy-impact` uses the pin that submission would take;
- alignment is reported as not yet assessable.

The report carries `dryRun: true`, and it satisfies no gate.

### D9. The `validation-current` precondition

This extends `durable-plans` D7 the way `pinDisposition` does:
- **File-held parts.** Before its transaction, `PlanService.approve` awaits `ValidationService.prepareStanding(planId, revision)`. That call reads only D2's file-held parts: hashes, and the cached adapter probe. It runs no CLI.
  - This pre-transaction gather is a third extension point beside D7's two, the precondition list and `pinDisposition`. It feeds `ctx.validation` only, and it is not a gate: only the `validation-current` entry decides. The shipped entries never read it.
- **DB-held parts.** `ctx` gains `validation`, computed inside the transaction by `ValidationService.standing(prepared)`. It reads the newest report, recomputes the DB-held parts, and compares the current input hash with the report's.
- **The entry.** `validation-current` is appended after the shipped entries. Every entry still runs, and failures still accumulate. It passes when a report exists, the report is ready, and its input hash is current. Its messages:
  - "not validated: run Validate";
  - "report N not ready: <e> errors, <q> unanswered questions, <w> unaccepted warnings, alignment <reason>";
  - "inputs changed since report N: <parts>", naming each differing part: the artifacts of a change, a base spec, an OpenSpec config, a group, profiles, the adapter, the strategy impact, claims, assessments or decisions, or the checks version.

Approval writes nothing new, so `plan-approval`'s "grants and triggers nothing else" holds. The report an approval rested on is derivable: the revision's newest report created before its `approved` event.

The window between the file read and the commit is milliseconds, and Start rechecks (V1).

### D10. Agent tools and the prompt

The tools:
- **`plan_validate({ plan_id, revision?, draft_id? })`.** The revision defaults to the newest `in_review` revision, else the approved one. Returns the report id (null on a dry run), `seq`, `inputHash`, `ready`, the readiness summary, and the errors and warnings, capped at 50 with a count.
- **`plan_validation_get({ plan_id, revision?, report_id? })`.** Returns the report, its standing computed now (read-only), and the revision's assessments and decisions.
- **`plan_assess({ plan_id, revision, alignment?, questions?, findings? })`.** Returns the new record ids.

They join `TEAM_ALLOWED_TOOLS`. Identity is bound to the calling session, and another team's ids read as not found.

No tool answers, accepts, resolves, excepts, authorizes, or approves.

`teamPrompt.ts`'s plan note adds:
- validation checks a plan and never approves it;
- how to assess: the five values, refs from the pinned strategy, and conditions with their gates;
- mandatory questions block until the owner answers them;
- agents never decide.

### D11. Human protocol and the Validation section

- **Messages.**
  - `team-plan-validate { teamPath, planId, revision }` takes no command id, because a repeat with unchanged inputs writes nothing.
  - `team-plan-assess { teamPath, planId, revision, alignment, commandId }`.
  - `team-plan-validation-decide` (D6).

  Each is answered by `team-plan-result` with additive fields, and each is listed in `CHAT_CONNECTION_TYPES`.
- **Pushes.** `team-plan-detail` gains `validation` per `in_review` or `approved` revision: the newest report, its standing, the assessments, and the decisions.
  - Standing is computed when the detail is built, coalesced to once per plan every 2 s, because linked-task changes push the detail often.
  - Pushes follow every validation, assessment, and decision write.
- **The `PlanValidationSection`** sits in the revision section and shows:
  - the standing badge: Not validated, Blocked (with counts), Ready, or Out of date (with the changed parts named);
  - **Validate**;
  - the report, grouped by row: Product alignment; Intent and implementation strategy; Scope and relations; Readiness;
  - per item: **Answer**, **Accept warning**, **Resolve condition**, **Record exception**, **Authorize exploration**, and the owner's **Assess alignment** form;
  - "Unassessed: no approved strategy", with the strategy capture link, when the pin is empty.

  An answer dialog on revision N+1 offers the same question's answer on revision N as a starting point.
- **The approve dialog** shows the standing, and it shows a `validation-current` refusal inline with **Validate**.
- **Connectivity.** Every control disables while disconnected, and refusals show inline.

### D12. Contracts published for the later Wave C changes

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| V1 Validation identity | D2 `ValidationInputs` and `inputHash`; `prepareStanding` and `standing` | `plan-execution` (Start's atomic comparison, R06), `revision-control` (the standing of a published revision) |
| V2 Reports and readiness | D1 report rows; D3 `Finding` and the finding-key builders (D3–D5); D7 `validationReadiness` and carried conditions | `plan-execution` (Start- and acceptance-gated conditions), `plan-supervision` (cards), `integration-candidates` (acceptance conditions) |
| V3 Relations | D4 `PlanRelation` | `plan-execution` (serialized pairs order scheduling), `integration-candidates` (overlapping capabilities validated together) |
| V4 OpenSpec adapter | D3 `probe`, capability names, `validate`, `showDeltas` | `execution-safety-recovery` (an adapter change during an attempt). Apply and Archive have no consumer yet: `plan-execution` leaves applying to the implementer's own workflow and archiving to the Lead (its D20) |
| V5 `validation-current` | D9 entry name and message format | `plan-execution` (Start reuses the entry) |

## Risks / Trade-offs

- [A moving master does not invalidate a report] → The identity covers every file the checks read (D2). Start rechecks, and `plan-execution` records its own baseline.
- [The owner approves while viewing an older report, and a newer one is also ready] → Both are current and ready by definition at commit time. The dialog follows pushes, and Start rechecks. A report id on the approve request would change `durable-plans`' compared payload (its D7), for no gate the precondition does not already enforce.
- [An agent's `aligned` unlocks alignment without a separate human act] → Approval is the explicit decision, made with the assessment and its author shown. Conflicts are sticky (D7), and the owner can record their own assessment.
- [CLI behavior changes across versions] → The version floor and capability probe guard against it, unknown shapes are errors, and `checksVersion` is part of the identity.
- [File reads at approval] → These are hashes only, bounded by plan size, and never the CLI.
- [Agent loops requesting validation] → Unchanged inputs write nothing, runs are single-flight, and CLI calls are limited to four at a time.
- [Decisions do not carry to a new revision] → This is by design, because the content changed. The view offers earlier answers as starting points.
- [Approvals now require a validation] → This is a behavior change for revisions already in review when this ships. AGENTS.md and the approve dialog say so, and **Validate** is one click.

## Migration Plan

The migration is additive: `CREATE TABLE IF NOT EXISTS` for the three tables and their indexes, with no backfill. Existing revisions show Not validated. An older build ignores the tables, and a rollback loses only validation history.

## Open Questions

- Should superseded reports be pruned? This can be deferred: reports are written only when inputs change, and nothing depends on pruning.
