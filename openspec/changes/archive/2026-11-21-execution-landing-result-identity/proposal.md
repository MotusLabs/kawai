# Proposal

## Why

When a change lands, Kawai accepts "the landed result" for the change's task (plan-landing, "A landing fact records each merge"; integration-landing, "Landing on the integration branch is acceptance"). Today it finds that result by commit: after the landing fact is written, the shared follow-on searches the change's rounds in number order and takes the first one whose commit equals the landed head. A commit does not identify a result. Two results of one task can name the same commit — a resubmission that only corrects the coverage map, the summary, or the evidence — and each gets its own round. The first same-commit round then wins even when it was superseded and never reviewed, so Kawai's acceptance receipt names a result that did not pass and leaves the reviewed one unaccepted.

This was observed in production after an execution landed a change (observed facts, not hypotheses):

- the change's last passing round (round 6) named the reviewed result R2 on commit C;
- an earlier round (round 5) named result R1 on the same commit C, with a placeholder coverage map; round 5 was superseded when R2 was submitted;
- after the merge of C, R1 carried Kawai's acceptance and R2 carried none.

The source landed correctly and the reviewed code is the code on the base branch; only the acceptance receipt is wrong. The landing effect that merged C already records the round that authorized it, so the authority Kawai needs is on hand and is discarded before acceptance.

## What Changes

- Kawai's acceptance after a landing names the result of the round that authorized the landing effect (the merge or fast-forward), read by that round's identity — never by searching rounds for the landed commit.
- The authorizing round must belong to the same execution and change and name the landed head; otherwise Kawai accepts nothing, logs the refusal, and leaves the task for the human, exactly as a refused acceptance does today. There is no fallback to a commit search.
- A replayed landing follow-on (a restart, or a stopped execution settling its merge) accepts the same result, or nothing if the task is already closed.
- Unchanged: the human's close or acceptance while the merge runs still wins (Kawai never accepts again), a result pinned to an older task revision still needs a stated reason (Kawai gives none, so it stays unaccepted), the landing fact, completion, and worktree cleanup.
- Prospective only: no historical receipt is rewritten. Correcting an already-wrong acceptance is a separate, owner-authorized action outside this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plan-landing`: Kawai's acceptance after a landing is bound to the authorizing round's result identity, for direct and integration-branch landing alike.

## Impact

- **Code (future implementation).** `src/server/plans/execution/executionLanding.ts` (`afterLanded` takes the landing effect's round id; the direct merge follow-on passes it) and `src/server/plans/landing/integration/integrationMechanism.ts` (the fast-forward follow-on passes it). No store, schema, migration, API, client, or acceptance-service change: `TaskResultService.accept` and the system caller's rights are untouched.
- **Tests (future).** A new integration test file for the identity table and property, through the production executor composition; the existing landing matrix keeps passing.
- **Data.** None. Existing rows, receipts, and journals are not read for repair or rewritten.
- **Risk.** Low blast radius (one selector, two call sites). The fail-closed branch can leave a landed change's task open where today Kawai would accept something; that is the existing refused-acceptance outcome, visible in the log and closable by the human.
