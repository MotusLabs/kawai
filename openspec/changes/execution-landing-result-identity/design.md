# Design

## Context

### Observed production path (master `a94d92fb`)

The landing follow-on is shared by both landing mechanisms:

1. Direct landing. The planner's `landing` stage names the change's current round (`executionPlanner.ts`, the `kind: 'landing', roundId: round.id` stage); `executor.applyLandingStage` reads it and calls `mechanism.land` → `applyLanding(deps, adapters, row, round)`. The merge step inserts the `merge` effect with `roundId: round.id` and a command pinned to the head it read (`executionLanding.ts`, step 4).
2. When the merge effect is done, `applyLandingOutcome` writes the landing fact, transitions the change to `landed`, and calls `afterLanded(deps, row, effect.executionId, head)` with `head = outcome.head`. **The effect's `roundId` is not passed.**
3. Integration-branch landing. `integrationMechanism.finish` inserts a `fast-forward` effect with `roundId: at.roundId` (the same stage round) and the candidate names `resultId: at.resultId`; `fastForwarded` writes the landing fact and calls `afterLanded(deps, row, effect.executionId, sha)`, again without the round id.
4. `afterLanded` (`executionLanding.ts:410`) cancels live landing effects, reads the task status, and, for a task that is neither done nor cancelled, selects
   `store.rounds(executionId, row.change).find(entry => entry.commitSha === head)` (line 423) and accepts `round.resultId` as the execution's system caller (line 427). `store.rounds` orders by round `number`, so `find` returns the **oldest** round on that commit.
5. `TaskResultService.accept` checks the system caller's `accept` right, the closing rule, that the result belongs to the task, and the stated-reason rule for a result needing re-evaluation; then it marks the result accepted and closes the task in one transaction. A throw is caught in `afterLanded` and logged as `plan_execution_accept_failed`.

The observed failure: a task's result R1 on commit C got round 5; a corrected resubmission R2 on the same C got round 6, which superseded round 5 (`insertRound`); round 6 passed CI and review and its merge landed C. Step 4 then found round 5 first and accepted R1. R2 stayed unaccepted. The source, landing fact, and CI were correct. This is a selection defect in step 4, not a defect of the reviewed change.

The existing landing matrix (`executionLandingMatrix.integration.test.ts`, "the task is done and its result accepted by Kawai") asserts acceptance of `rounds.at(-1).resultId` on a single-round change, so first-match and the correct rule agree there and the defect was invisible.

### Existing contracts this change keeps

- plan-landing "A landing fact records each merge" and integration-landing "Landing on the integration branch is acceptance": Kawai accepts the landed result and closes the task.
- plan-execution "Closing an execution task by hand stops its change", scenario "A hand close while the merge runs": the human's close wins; Kawai never accepts again.
- execution-recovery "Late results stay pinned and never win": a stale-pinned result needs a stated reason; a superseded result is never accepted in place of the current stage's work.
- The system caller's rights (`systemCaller.ts`): unchanged; this change adds no right and no origin.

## Goals / Non-Goals

**Goals:** bind Kawai's post-landing acceptance to the result of the round that authorized the landing effect; fail closed when that identity is absent or inconsistent; keep every existing precedence and refusal.

**Non-Goals:** rewriting, re-deriving, or "correcting" any past acceptance; changing the acceptance service, the round store, the planner, the effect schema, or the landing fact; closing the pre-existing crash window between the `landed` transition and the acceptance (see Risks); changing which head is merged.

## Decisions

### D1 — The landing effect's round is the authority

The merge and fast-forward effects already record `roundId`, written when the landing step was authorized by that round's pass (or carry). That row is the only durable record of which round's verdict the landed commit answered. `afterLanded` takes it from the effect:

```ts
export interface LandedStep { head: string; roundId: string | null }
export async function afterLanded(deps: LandingDeps, row: ChangeRow, executionId: string, landed: LandedStep): Promise<void>
```

The direct follow-on passes `{ head, roundId: effect.roundId ?? null }`; `fastForwarded` passes `{ head: sha, roundId: effect.roundId }`.

Alternatives rejected:
- *Last round on the commit* (`filter(...).at(-1)`): agrees with D1 only while no round is inserted after authorization; it is still a commit search and carries no authority. A commit never identifies a result (contract I2).
- *Latest passing round*: re-derives authority at follow-on time instead of reading what authorized the step; a replay after a later round would drift.
- *Newest unsuperseded result of the task*: may name a result submitted during the merge that was never gated.
- *Storing a result id on the effect or the landing fact*: duplicates what the round already records and needs a migration.

### D2 — Confirm the identity, then accept; never fall back

A small pure helper (new file `src/server/plans/execution/landingRound.ts`, keeping `executionLanding.ts` under 500 lines) resolves the authorizing round:

```ts
type Authorizing = { ok: true; round: RoundRow } | { ok: false; reason: 'no-round' | 'round-missing' | 'round-mismatch' | 'commit-mismatch' }
export function authorizingRound(store: Pick<ExecutionStore, 'round'>, executionId: string, change: string, landed: LandedStep): Authorizing
```

- `roundId` null → `no-round`; no row → `round-missing`;
- `round.executionId !== executionId || round.change !== change` → `round-mismatch`;
- `round.commitSha !== landed.head` → `commit-mismatch`.

A carried round names the carried head and keeps its source's result (`insertCarriedRound`); a re-gate round keeps the failed round's result and commit (`insertRegateRound`); both resolve by identity with no special case. On `ok: false`, Kawai accepts nothing and logs `plan_execution_accept_identity_refused` with execution, change, round id, head, and reason; the task stays open for the human, as for today's refused acceptance. There is no commit-search fallback: falling back re-opens the defect.

The round's outcome is not re-checked: the round authorized the landing step when it passed, and the merge cannot be undone; a later supersession of that round (none happens while the change is `landing` — the planner's result stage skips a landing change) does not change what landed.

### D3 — Precedence and refusals stay in their current owners

The status guard runs first, as today: a task done or cancelled (by the human's accept, the human's cancel, or an earlier Kawai acceptance) is never touched, and no identity is resolved for it. A stale-pinned result reaches `accept` without a reason and is refused there, logged as `plan_execution_accept_failed`. A result that is not the task's is refused there too. `afterLanded`'s cleanup and completion steps run whatever the acceptance outcome, unchanged.

### D4 — Replay is by the same effect row

Every path that re-runs the follow-on — the planner's `landing-outcome` stage for a settled `done` merge or fast-forward effect of a `landing` change (including one inspected `done` after a restart), and a stopped execution's settlement of its running merge — reads the same effect row (`executor.applyLandingFollowOn` by effect id), so it resolves the same round and the same result. A second run finds the task done and writes nothing. No new key or table is needed.

### D5 — Prospective only; history is the owner's

The fix changes the next landing's selection. It reads no historical receipt to repair, writes no past acceptance, and makes no claim that an earlier wrong acceptance is now correct. Correcting the observed receipt, if wanted, is a separate owner-authorized action through supported human task actions; this change neither provides nor performs it.

## Acceptance oracles

### Decision table — the follow-on's acceptance

Axes: the effect's round reference (Ref), the round row it resolves (Row), the round's commit vs the landed head (Commit), the task's status when the follow-on runs (Task), the authorizing result's pin (Pin), and other results of the task (Siblings). Outputs are observable only: which result ids carry an acceptance, the task status, and the log event.

| Id | Mechanism | Ref | Row | Commit | Task | Pin | Siblings | Accepted results after | Task after | Log |
|---|---|---|---|---|---|---|---|---|---|---|
| O1 | direct | set | this exec+change | = head | open | current | none | {auth} by Kawai | done | — |
| O2 | direct | set | this exec+change | = head | open | current | earlier superseded round, same commit, other result | {auth}; earlier stays unaccepted | done | — |
| O3 | integration | set | this exec+change | = head | open | current | earlier superseded round, same commit, other result | {auth}; earlier stays unaccepted | done | — |
| O4 | direct | set (carried round) | this exec+change | = carried head | open | current | source round on the pre-update head | {carried round's result} | done | — |
| O5 | direct | set (re-gate round) | this exec+change | = head | open | current | failed round, same result and commit | {that result}, once | done | — |
| O6 | direct | set | this exec+change | = head | open | current | result submitted after the merge started (no round) | {auth}; new result unaccepted | done | — |
| O7 | direct | set | this exec+change | = head | open | current | a later round on the same commit inserted at store level after the step was authorized | {auth}; later round's result unaccepted | done | — |
| O8 | * | null | — | — | open | * | same-commit round present | ∅ | open | identity refused: no-round |
| O9 | * | set | missing | — | open | * | same-commit round present | ∅ | open | identity refused: round-missing |
| O10 | * | set | other change, or other execution | * | open | * | * | ∅ | open | identity refused: round-mismatch |
| O11 | * | set | this exec+change | ≠ head | open | * | same-commit round present | ∅ | open | identity refused: commit-mismatch |
| O12 | * | * | * | * | done by human accepting result X | * | * | {X} by human only | done | — |
| O13 | * | * | * | * | cancelled by human | * | * | unchanged (∅ when none) | cancelled | — |
| O14 | direct | set | this exec+change | = head | open | older task revision | * | ∅ | open | accept failed (needs stated reason) |
| O15 | * | set | this exec+change | = head | done by Kawai (replay) | * | * | {auth}, exactly one acceptance row and journal entry | done | — |
| O16 | direct | set | this exec+change | = head | open | current | earlier same-commit round | restart with the merge effect `running`: after inspection, {auth} once | done | — |

In every row the change is `landed` with exactly one landing fact, and completion and cleanup behave as today.

Unreachable or excluded combinations:
- Task row null (`row.taskId === null`): Kawai accepts nothing and resolves no identity; unchanged behaviour, covered by the existing suite, not a new row.
- O7 is not reachable through the planner today (the result stage skips a `landing` change, `executionPlanner.ts` result-stage guard); it is reached by inserting the round through the store and exists to kill the "last same-commit round" mutant and guard future planner changes.
- O10 with "other execution" cannot arise from production writes (effects and rounds are inserted by the same execution); it is reached by store-level insertion as a fail-closed oracle.
- A result belonging to another task under a correct round: rounds are inserted from the change's own task's results; refused by `accept` if ever reached (existing guard), not a new row.

### Properties

- **P1 — identity, not commit.** Let `before` and `after` be the task's acceptances (result id with acceptor) just before and just after one application of the follow-on, and `delta = after \ before` the acceptances it wrote. For any seeded round history of one change: (a) `before ⊆ after` with every acceptor unchanged, so an existing acceptance is never removed or rewritten; (b) when the task is not done or cancelled before the follow-on and the authorizing result's pin is current, `delta = {authorizing round's resultId, accepted by Kawai}`; (c) otherwise — the task already done (by a human accepting any result, or by an earlier Kawai acceptance), cancelled, or the pin stale — `delta = ∅` and the task status is unchanged. In every case `delta` never contains a result id other than the authorizing round's. Generator: 1–8 rounds per change with commits drawn from a pool of 2 SHAs (so same-commit collisions are frequent), outcomes drawn from {superseded, fail, pass}, optional carried and re-gate rows, the authorizing round drawn uniformly among the rounds whose commit equals the landed head, and optional later same-commit rounds; the task's initial state drawn from {open, active, blocked, done by a human accepting a random result of the task, done by an earlier Kawai acceptance of the authorizing result, cancelled}, and the authorizing result's pin from {current, older revision}. Seams: the real `ExecutionStore` and `TaskResultService` over `freshTestDatabase`, `afterLanded` called with a `LandedStep`. Seed `0x5eed1d`, declared 64 cases through `propertyCases(64)`.
- **P2 — fail closed.** For any `LandedStep` whose round reference is null, unknown, of another change or execution, or on another commit, with any same-commit rounds present, the accepted set is unchanged and the task status is unchanged. Same seams and generator family; seed `0xc105ed`, declared 64 cases.
- **P3 — precedence and replay.** For the follow-on applied 1–3 times, with an optional human accept (of any result) or cancel inserted before the first application, the task has at most one acceptance in total, and it is the human's when the human closed first. Seed `0x0ba1d3`, declared 64 cases.

No new dependency: the generators use the in-tree seeded PRNG pattern the existing property tests use, and `propertyCases` from `src/server/__tests__/helpers/propertyCases.ts`.

### Production-composition rows and wiring mutants

O1, O2, O3, O6 and O16 run through the production executor composition (`executionMatrixHarness.ts`: `startedExecution`, `submitWork`, `review`, ticks), with a second result submitted on the same commit through the task result service. O2 is the observed defect's reproduction: it fails on the base head (R1 is accepted) and passes on the fix.

### Mutation targets

| Mutant | Change | Killed by |
|---|---|---|
| M1 | restore `rounds(...).find(entry => entry.commitSha === head)` | O2, O3, P1 |
| M2 | `rounds(...).filter(entry => entry.commitSha === head).at(-1)` | O7, P1 |
| M3 | drop the commit equality check | O11, P2 |
| M4 | drop the execution/change check | O10, P2 |
| M5 | fall back to the commit search when the identity is refused | O8, O9, P2 |
| M6 | direct follow-on passes `roundId: null` (wiring) | O1, O2 (production composition) |
| M7 | `fastForwarded` passes `roundId: null` (wiring) | O3 (production composition) |
| M8 | resolve the identity before the status guard and accept on success regardless of status | O12, O13 (the accepted set or journal changes) |

## Risks / Trade-offs

- **Fail-closed leaves a task open.** O8–O11 leave a landed change's task open where today Kawai would accept something. This is the existing refused-acceptance outcome (logged; the human can close the task). None of these rows arise from production writes on current master except through corruption, so no regression in normal landings is expected.
- **Pre-existing crash window, unchanged.** The direct path writes the landing fact and the `landed` transition before `afterLanded` runs; a crash between them leaves the task open, and the follow-on is not replayed for a `landed` change. This change neither widens nor closes it; it is recorded as a follow-up candidate, not in scope.
- **Observed head-pinning question, not verified here.** The merge command pins the head read at step 3, not the round's commit. With D2, any divergence between them refuses acceptance rather than accepting a mismatched result; whether the merge itself can ever land an un-gated head is outside this change and stays a hypothesis for a separate review.

## Migration Plan

None. No schema, data, or API change. Deploying the fix affects only landings that complete after it.

## Recovery matrix

The change adds no new recovery mechanism, exclusive slot, or replay key: replay reads the existing effect row (D4). The implementation adds one row to `docs/recovery-matrix.md` — "Landing follow-on replayed after a restart" → "accepts the effect's authorizing round's result, once" — citing O16's and O15's tests, because the binding is the recovery-relevant guarantee.

## Open Questions

None blocking. The choice in D2 not to re-check the authorizing round's outcome at follow-on time is a decision the reviewer may contest; changing it would add a refusal row, not change the accepted result in any reachable row.

## Implementation contract

### Acceptance

- A1: After a direct or integration-branch landing, Kawai accepts exactly the result of the round the landing effect names, for every row O1–O7 and O15–O16, including when an earlier or later round names the same commit.
- A2: When the effect's round reference is null, unknown, of another change or execution, or on another commit, Kawai accepts nothing, the task stays open, and `plan_execution_accept_identity_refused` is logged with its reason (O8–O11).
- A3: A task done or cancelled when the follow-on runs keeps its status and acceptances, and a stale-pinned result stays unaccepted (O12–O14).
- A4: Properties P1–P3 pass at their declared case counts under `--full-properties`; mutants M1–M8 are each killed by a named test.
- A5: O1, O2, O3, O6 and O16 run through the production executor composition; O2 fails on the base head and passes on the fix.

### Invariants

- I1: A shared commit never selects a result; only the effect's round identity does.
- I2: `TaskResultService`, `systemCaller.ts`, the round and effect stores, the planner, and the schema are unchanged.
- I3: No past acceptance, receipt, or journal entry is read for repair or rewritten.
- I4: Landing facts, the `landed` transition, worktree cleanup, and execution and plan completion behave as before in every row.

### Scope

- `openspec/changes/execution-landing-result-identity/**`
- `src/server/plans/execution/executionLanding.ts`
- `src/server/plans/execution/landingRound.ts`
- `src/server/plans/landing/integration/integrationMechanism.ts`
- `src/server/__tests__/landingResultIdentity.integration.test.ts`
- `src/server/__tests__/landingResultIdentityProperties.test.ts`
- `docs/recovery-matrix.md`

### Verification

- V1: The decision table is committed as a table-driven test whose rows carry the oracle ids; each property runs seeded through `propertyCases`.
- V2: The result maps each oracle id and property to a literal test title and each mutant to the test that killed it, with the negative control for O2 run on the base head.
- V3: `bun run check --full-properties` passes on the clean committed head, and `scripts/verify-result.ts` exits 0 for that commit.

### Excluded

- X1: Repairing or re-deriving any historical acceptance or receipt, and any live-database write.
- X2: Changes to the acceptance service, system caller rights, round/effect schema, planner, merge pinning, or the pre-existing crash window between the `landed` transition and the acceptance.
- X3: Client or view changes.
