# Blind oracle reading — inputs only (A1)

This packet holds the inputs of the change's acceptance oracles with every output left as `?`. It is for one independent reading (docs/agent-collaboration.md, "Write acceptance as oracles", steps 1–2): fill in each `?` from the behavior contract alone, before seeing the author's answers.

## What to read

- This file.
- The change's delta spec: `openspec/changes/execution-landing-result-identity/specs/plan-landing/spec.md`.
- For existing behavior the delta spec relies on, the main specs: `openspec/specs/plan-landing/spec.md` ("A landing fact records each merge"), `openspec/specs/integration-landing/spec.md` ("Landing on the integration branch is acceptance"), `openspec/specs/plan-execution/spec.md` ("Closing an execution task by hand stops its change"), `openspec/specs/execution-recovery/spec.md` ("Late results stay pinned and never win").
- The current source, if needed, for how things work today.

Do not read the change's `design.md`, `tasks.md` or `proposal.md` for this reading: they hold the author's expected outputs and implementation decisions. The author's outputs are pinned at commit `50ba1eba68a6b2d4bf0bd6c3a9eb55d1118f1d46` and are revealed after your answers are recorded.

## Terms

- **Change**: one plan change being landed by an execution; it has one task.
- **Round**: a gating round of the change. Each round names one result of the task and one commit. Rounds are numbered in order. Several rounds, and several results, can name the same commit.
- **Landing step**: the recorded merge (direct landing) or fast-forward (integration-branch landing) that put the change on its base. The step records a reference to a round, the one whose pass (or carry) authorized it.
- **Follow-on**: what Kawai does after the landing fact is written: accept a result and close the task, clean up, complete the execution and plan.
- **Authorizing round / result**: the round the landing step references, and the result that round names.
- **Carried round**: a round created when a clean base merge carries a passed round onto a new head; it names the same result as the round it carries.
- **Re-gate round**: a passing round that re-gates a failed round with the same result and commit.
- **Pin**: the task revision a result was submitted under; "older" means the task has since published a newer revision.
- **Open**: the task is open, active or blocked (not done, not cancelled).

## Outputs to fill in

For every row give:

- **Accepted results after** — which result ids carry an acceptance after the follow-on, and who accepted each (Kawai or human); write `∅` for none.
- **Task after** — the task's status after the follow-on.
- **Log** — any refusal or failure the follow-on records, and its reason, or `—` for none.

Also state whether the change is landed with its landing fact, and anything else you consider observable and required.

## Decision table (inputs)

Axes: landing mechanism; the landing step's round reference (Ref); the round row it resolves to (Row); that round's commit vs the landed head (Commit); the task's status when the follow-on runs (Task); the authorizing result's pin (Pin); other results or rounds of the task (Siblings). `*` means any value.

| Id | Mechanism | Ref | Row | Commit | Task | Pin | Siblings | Accepted results after | Task after | Log |
|---|---|---|---|---|---|---|---|---|---|---|
| O1 | direct | set | this execution and change | = head | open | current | none | ? | ? | ? |
| O2 | direct | set | this execution and change | = head | open | current | an earlier, superseded round on the same commit naming another result | ? | ? | ? |
| O3 | integration | set | this execution and change | = head | open | current | an earlier, superseded round on the same commit naming another result | ? | ? | ? |
| O4 | direct | set (a carried round) | this execution and change | = carried head | open | current | the source round on the pre-update head | ? | ? | ? |
| O5 | direct | set (a re-gate round) | this execution and change | = head | open | current | the failed round with the same result and commit | ? | ? | ? |
| O6 | direct | set | this execution and change | = head | open | current | a new result submitted after the merge started (no round for it) | ? | ? | ? |
| O7 | direct | set | this execution and change | = head | open | current | a later round on the same commit, naming another result, inserted after the landing step was authorized | ? | ? | ? |
| O8 | * | none (no round referenced) | — | — | open | * | a round on the landed commit exists | ? | ? | ? |
| O9 | * | set | no such round | — | open | * | a round on the landed commit exists | ? | ? | ? |
| O10 | * | set | a round of another change, or of another execution | * | open | * | * | ? | ? | ? |
| O11 | * | set | this execution and change | ≠ head | open | * | a round on the landed commit exists | ? | ? | ? |
| O12 | * | * | * | * | done: the human accepted result X during the merge | * | * | ? | ? | ? |
| O13 | * | * | * | * | cancelled by the human during the merge | * | * | ? | ? | ? |
| O14 | direct | set | this execution and change | = head | open | older task revision | * | ? | ? | ? |
| O15 | * | set | this execution and change | = head | done: Kawai already accepted the authorizing result (the follow-on runs again) | * | * | ? | ? | ? |
| O16 | direct | set | this execution and change | = head | open | current | an earlier round on the same commit | ? | ? | ? |

O16's event: the server restarts while the merge is still recorded as running; on restart the merge is inspected, found done, and its follow-on runs.

Also say which rows you think are unreachable through normal operation, and any combination of the axes you think the table is missing.

## Properties (inputs)

For each, state the property you would require (what must hold), or `?` if the contract does not determine it.

- **P1.** A seeded history of 1–8 rounds for one change, commits drawn from a pool of two (so same-commit rounds are common), outcomes from {superseded, fail, pass}, with optional carried and re-gate rounds; the landing step references one round whose commit is the landed head; optional later rounds on the same commit. The task's state before the follow-on is drawn from {open, active, blocked, done by a human accepting a random result of the task, done by an earlier Kawai acceptance of the referenced round's result, cancelled}, and the referenced result's pin from {current, older}. Compare the task's acceptances (result id with acceptor) and status just before and just after one follow-on. Required property: `?`
- **P2.** As P1, but the landing step's round reference is none, unknown, of another change or execution, or on a commit other than the landed head, with rounds on the landed commit present. Required property: `?`
- **P3.** The follow-on runs one to three times for the same landing step; optionally, before the first run, the human accepts any result or cancels the task. Required property over the task's acceptances and status: `?`
