# Proposal

## Why

Plan changes get stall alerts (plan-supervision) and convergence diagnoses
(review-convergence). A task no execution owns gets neither, except a
convergence notice that counts formal reviews only. The advisory rounds before
a formal review are invisible to Kawai. On 2026-11-09, task 97d6bb7b (manual,
the `pckh` writer) ran about five hours and 42 task messages, mostly advisory
rounds, with one formal review. Nothing told its coordinator that the task had
gone that long without progress. The advisory budget (a coordinator rule sent
to the Lead the same day) needs a signal that it is being exceeded.

## What Changes

- Kawai watches each active task no execution owns. When the task gathers
  `N = 10` agent or human messages, and `T = 3 h` passes, without **progress**
  (a new revision, a submitted result, or a counted review), it sends one
  **stall notice**.
- The notice journals the episode on the task: message count, elapsed time,
  the last progress and its kind, and the senders counted. When the task's
  creator is a session, it also sends that session one message from Kawai,
  tagged `task-stall`. It names the advisory-checkpoint rules in
  `docs/agent-collaboration.md` and the coordinator's options. Nothing waits,
  blocks, or changes status.
- One notice per episode. The notice itself counts as progress, so a loop
  that keeps going gets a notice after each further `N` messages and `T`
  hours. A replayed or concurrent evaluation sends nothing twice.
- Evaluated when task mail commits (no timer). A task that goes silent never
  gets a notice. Silence is not an advisory loop.
- Out of scope: tasks an execution owns (plan supervision covers them), and
  blocked, done, or cancelled tasks. Per-team thresholds are deferred.

## Capabilities

### New Capabilities
- `task-stall-notices`: when Kawai notices a manually managed task gathering
  mail without progress, what the notice says, whom it reaches, and that it
  is sent once per episode.

### Modified Capabilities
<!-- none: the review-convergence notice and plan-supervision stall alerts are unchanged -->

## Impact

- Server: a new notice module beside `src/server/team/convergenceNotice.ts`,
  subscribed to the mailbox's enqueue notifications. It reads task revisions,
  results, and counted reviews through the existing stores.
- Database: one additive migration, table `team_task_stall_notices` keyed by
  `(task_id, anchor_at)`. No backfill.
- Docs: a bullet in `docs/architecture/tasks.md`, the notice in the "Keep
  advisory checkpoints separate from final review" section of
  `docs/agent-collaboration.md`, and a `docs/recovery-matrix.md` row for the
  replay key.
- No client change, no new agent tool, no change to mail delivery or routing.
