# Design

## Context

Workspace discovery (`src/server/workspace/`) builds one snapshot of every repository the server's sessions touch. Its pieces:

- `WorkspaceCoordinator` (`workspaceCoordinator.ts`) runs one pass at a time and merges requests that arrive during a pass into the next one.
- A pass rebuilds the affected repositories, all at once. For each one it calls `buildRepository` (Git) and then `refreshOpenSpec`.
- `refreshRepositoryOpenSpec` (`openspecDiscovery.ts`) runs `openspec list --json` in every worktree of the repository at once (`Promise.all`), with no cache.
- `WorkspaceWatcher` (`workspaceWatcher.ts`) watches each repository's common dir, `refs/heads`, `worktrees/`, each worktree root, and each OpenSpec `changes/` directory and change directory. It reports changed paths after a 400 ms debounce and forces a full reconciliation every 30 s.

So a repository with W worktrees costs W Node processes on every reconciliation, all started together, and again on every Git or root-level event in any of its worktrees. Measured on 2026-11-10 with W = 148:

- 676 processes in 2 minutes, 235 at peak;
- a 20 s sample averaged 49 running;
- workspace `cpu.pressure` some avg60 stayed between 30% and 33% against a 6-CPU quota.

Alone, one run takes 0.15 s of wall time on an idle machine, which shows the cost is the count, not any single run.

What `openspec list --json` (1.16.0) reads, from `dist/core/root-selection.js` and `dist/core/list.js`:

- **The root.** It is the nearest ancestor of the working directory that contains an `openspec/` directory. That directory's contents decide whether it is a planning root or a pointer to a store.
- **Without a nearest root**, it falls back to a global `defaultStore` or the registered stores. Without those either, it reports `no_openspec_root`.
- **The changes.** It lists the active change directories: entries of `openspec/changes/` that are directories, except `archive`. For each one it reads the task progress and the latest modification time of the files under it.

A worktree under `.worktrees/<name>` that has no `openspec/` of its own therefore resolves to the main checkout's root.

## Goals / Non-Goals

**Goals:**

- In steady state, start a process only when a worktree's OpenSpec inputs changed, or once per 10 minutes as a safety net.
- Never run more than 3 OpenSpec processes at once, however many worktrees or repositories there are.
- Keep every existing `openspec-visibility` scenario passing: external task completion appears on the next pass, rapid writes coalesce, failures stay isolated and keep last-valid values.
- Make the effect measurable on a live instance.

**Non-Goals:**

- Reading OpenSpec files in-process instead of running the CLI. That would duplicate the CLI's parsing, and drift from it.
- Changing Git discovery, the watch targets, the reconciliation period, or the snapshot shape.
- Cleaning up stale worktrees. That is an operator task. Removing the 19 merged or pushed candidates found on 2026-11-10 would cut only about 13% of the runs.

## Decisions

### D1. A stat fingerprint guards each CLI run

`openspecFingerprint.ts` exports `fingerprintOpenSpecInputs(worktreePath)`, which returns a string or `null`. It reads only file metadata, through async `fs` calls:

1. **Root.** Walk up from the worktree path to the first directory containing an `openspec` entry that `stat` reports as a directory. Record that root's path, or `none`.
2. **Root entries.** For each entry of `<root>/openspec/`, record its name, type, size, and `mtimeMs`. This catches `config.yaml`, pointer files, and a new or removed `changes/`.
3. **Change entries.** For each entry of `<root>/openspec/changes/`, record its name and type. Then, for every directory entry other than `archive`, walk it and record every file's relative path, size, and `mtimeMs`. A symbolic link is recorded by its `stat`, and the walk does not follow it into a directory.
4. **Output.** Sort the records and hash them with SHA-256.

The walk stops at 5,000 records and returns `null`, and so does any read error. `null` never matches, so the CLI runs.

Alternatives:

- **Directory mtimes only.** Rejected: editing `tasks.md` in place leaves its directory's mtime unchanged.
- **Content hashes.** Rejected: they cost a read of every file on every pass, while size and mtime already change on every write the CLI could observe.

### D2. Reuse is a pure decision over the previous entry

The coordinator owns one `OpenSpecDiscoveryCache`, a map from worktree path to `{ fingerprint, discoveredAt, state }`. The state is the `WorktreeOpenSpecState` the CLI produced, stored only when `stale` is false. `shouldRunOpenSpec(previous, fingerprint, now)` is pure and follows table RD.

The fingerprint is taken *before* the run and stored with that run's result. A write that lands during the run therefore changes the next fingerprint, and the next pass runs again. A pass drops cache entries for worktrees it no longer lists. The cache lives in memory only, so every server start runs the CLI once per worktree, through the pool.

Alternative: key the cache on the watcher's events. Rejected because the watcher is explicitly a latency optimization that misses events. The reconciliation pass must stay correct on its own, and a fingerprint gives it that.

### D3. One server-wide pool of 3 runs the CLI

`openspecPool.ts` exports a FIFO semaphore with `run(task)`, and its size is 3. Every production OpenSpec list run goes through the one pool instance in `defaultDiscoveryApi`. The 15 s timeout stays inside `runOpenspecList`, whose timer starts after the spawn, so time spent in the queue never counts. The pool records its peak concurrency and how many runs it started.

Why 3: the workspace has 6 CPUs, and agents, `bun run check`, and the server share them. Three runs finish a cold start of 148 worktrees in about 148 × 0.15 s ÷ 3, roughly 8 s on an idle machine, which is well inside the 30 s reconciliation period.

Alternative: cap concurrency per repository. Rejected, because several repositories rebuild in one pass at once, and a per-repository cap would multiply.

Coalescing per worktree is not needed. The coordinator runs one pass at a time, and a pass lists each worktree once, so two runs for one worktree never overlap.

### D4. Counters and one debug line per pass

`refreshRepositoryOpenSpec` reports `{ runs, reused }` per call. The coordinator sums them per pass and logs `workspace_openspec_pass` at debug level with `runs`, `reused`, `worktrees`, `poolPeak` (since the last pass), and `durationMs`. Nothing else is logged. The counters are the measurement V5 reads.

## Risks / Trade-offs

- **An input the fingerprint misses.** Examples: a global `defaultStore` change for a worktree with no root, a file edited behind a symlinked directory, or an edit with the same size and the same millisecond mtime. Such a change shows up within 10 minutes, the reuse limit. This is accepted, and the excluded clause X2 names it.
- **Fingerprint cost.** About 30,000 `stat` calls per reconciliation at today's 148 worktrees and roughly 200 change files each. V5 measures the pass duration before and after, and the change does not ship if the pass gets slower.
- **A cold start is slower to fill in.** Results now arrive within about 8 s, where all 148 ran together before (and, under the storm, took longer). Accepted.
- **mtime precision on other filesystems.** On a filesystem with coarse mtimes, two writes within one tick look the same. The 10-minute limit bounds this.

## Acceptance oracles

### Fingerprint inputs (FP)

Hazard reference: "A key input no fixture varies" (`docs/oracle-hazards.md`). Each row varies one input from the same base fixture: a worktree with its own `openspec/`, `config.yaml`, two active changes each holding `proposal.md`, `tasks.md`, and `specs/a/spec.md`, and one archived change. The column says whether the fingerprint equals the base fixture's.

| id | Variation | Fingerprint |
|----|-----------|-------------|
| FP1 | none (fingerprint taken twice) | equal |
| FP2 | `tasks.md` rewritten, same size, new mtime | differs |
| FP3 | `tasks.md` rewritten, different size, mtime restored | differs |
| FP4 | a file added under an active change's `specs/` | differs |
| FP5 | a file removed from an active change | differs |
| FP6 | a new change directory under `changes/` | differs |
| FP7 | an active change moved into `archive/` | differs |
| FP8 | a file under `archive/` rewritten | equal |
| FP9 | `config.yaml` rewritten | differs |
| FP10 | a file outside `openspec/` (`src/x.ts`) rewritten | equal |
| FP11 | the worktree's `openspec/` removed, so an ancestor's root resolves | differs |
| FP12 | no `openspec/` anywhere up to the filesystem root, taken twice | equal, and not `null` |
| FP13 | a plain file named `changes/notes.txt` added | differs |
| FP14 | an active change holding 5,001 files | `null` |
| FP15 | the root unreadable (`chmod 000` on `openspec/changes`) | `null` |

### Reuse decision (RD)

Here `previous` is the cache entry, `fp` compares the new fingerprint with the stored one, and `age` is `now − discoveredAt`. A failed run stores no entry, so "previous failed" reads as "none". Every combination of the three inputs matches exactly one row.

| id | previous | fp | age | Result |
|----|----------|----|-----|--------|
| RD1 | none | * | * | run |
| RD2 | entry | new fingerprint `null` | * | run |
| RD3 | entry | differs | * | run |
| RD4 | entry | equal | < 10 min | reuse |
| RD5 | entry | equal | ≥ 10 min (exactly 600,000 ms included) | run |

### Discovery outcomes (DO)

These rows run through `refreshRepositoryOpenSpec` with an injected runner, cache, and clock.

| id | Situation | Runner calls | Cache after | Published state |
|----|-----------|--------------|-------------|-----------------|
| DO1 | first discovery, success | 1 | entry stored with the pre-run fingerprint | the result |
| DO2 | second pass, RD4 | 0 | unchanged | the cached result, equal to DO1's |
| DO3 | run fails after a cached success | 1 | entry removed | last-valid values marked stale (existing behavior) |
| DO4 | pass after DO3, fingerprint unchanged | 1 | entry stored on success | the new result |
| DO5 | missing-root payload | 1 | entry stored (empty, not stale) | empty, not stale |
| DO6 | a file written while the runner is in flight | 1, then 1 on the next pass | the pre-run fingerprint | the next pass reruns |
| DO7 | worktree no longer listed | 0 | its entry dropped | absent |

### Pool property (PL1)

- **Property.** For n tasks with random durations submitted at random offsets, at most 3 are running at any moment. Each task's result reaches its own caller exactly once. The peak equals min(3, n) when all tasks are submitted before the first one settles. A task that throws releases its slot.
- **Generator.** A seeded PRNG gives n from 1 to 60, each duration from 0 to 20 fake-clock ticks, and 10% of tasks throwing.
- **Seams.** The pool and a fake clock. No processes.
- **Seed and count.** Seed `0x0a5e`, 300 cases. No new dependency.

### Queue time (QT1)

A fake runner records the moment its timer starts relative to the spawn. With the pool full for 20 s of fake time, a queued run whose process answers in 14 s returns a success. The mutant that starts the timer at submission instead of at spawn must fail it.

### Production composition (PC1)

Hazard M1 ("an oracle behind a hand-built harness") applies. The fixture:

- a real Git repository with 12 worktrees (the main one and 11 linked), in a temporary directory;
- a stub `openspec` executable first on `PATH`, which appends its pid and start and end times to a log, holds a lock file for 300 ms, and prints a valid payload;
- a `WorkspaceCoordinator` built with `defaultDiscoveryApi`, the production composition.

Steps:

1. `reconcile()`. 12 stub runs, peak overlap at most 3 from the log.
2. `reconcile()` again. 0 runs.
3. Rewrite one worktree's `tasks.md`, then `reconcile()`. 1 run, and that worktree's snapshot shows the new progress.
4. Advance the injected clock by 10 minutes, then `reconcile()`. 12 runs.

## Landed implementation contract (PR #384, historical)

The contract the implementation was judged against, kept verbatim for history. The parsed contract of this change is the closeout contract at the end of this file.


### Acceptance

- A1: Unchanged inputs: a reconciliation over worktrees whose OpenSpec inputs have not changed, within 10 minutes of their successful discovery, starts no `openspec` process (RD4, DO2, PC1 step 2).
- A2: Changed inputs: any change the FP table marks "differs", any failed last run, and any result 10 minutes old or more makes the next pass run the CLI for that worktree (FP2–FP7, FP9, FP11, FP13, RD1–RD3, RD5, DO3, DO4, PC1 steps 3–4).
- A3: Concurrency: no more than 3 `openspec list` processes run at once across the server (PL1, PC1 step 1).
- A4: Queue time: time in the queue never counts toward the 15 s timeout (QT1).
- A5: Existing behavior: every existing test in `openspecDiscovery.test.ts`, `openspecMerge.test.ts`, `changeRegistry.test.ts`, `workspaceCoordinator.test.ts`, and `workspaceWatcher.test.ts` passes unchanged, except for injected-dependency signatures.
- A6: Logging: each coordinator pass logs one `workspace_openspec_pass` debug line with `runs`, `reused`, `worktrees`, `poolPeak`, and `durationMs`.

### Invariants

- I1: A cached state is always a non-stale CLI result for that worktree path, never copied between worktrees.
- I2: The stored fingerprint is the one taken before the run that produced the stored state.
- I3: `fingerprintOpenSpecInputs` only reads metadata. It never opens a file for reading and never writes.
- I4: Every production `openspec list` spawn passes through the one pool.

### Scope

- `src/server/workspace/openspecDiscovery.ts`
- `src/server/workspace/openspecFingerprint.ts`
- `src/server/workspace/openspecPool.ts`
- `src/server/workspace/openspecDiscoveryCache.ts`
- `src/server/workspace/workspaceCoordinator.ts`
- `src/server/bootstrap.ts`
- `src/server/__tests__/openspecDiscovery.test.ts`
- `src/server/__tests__/openspecFingerprint.test.ts`
- `src/server/__tests__/openspecPool.test.ts`
- `src/server/__tests__/openspecDiscoveryReuse.test.ts`
- `src/server/__tests__/workspaceCoordinator.test.ts`
- `src/server/__tests__/workspaceOpenspecComposition.integration.test.ts`
- `src/server/__tests__/fixtures/openspec-stub/**`
- `docs/architecture/*.md`
- `docs/recovery-matrix.md`

### Verification

- V1: FP1–FP15 are committed verbatim as a table-driven test. The mutants that drop size, drop mtime, drop the root path, include `archive/`, or skip the root entries each fail a named row.
- V2: RD1–RD5 and DO1–DO7 are committed verbatim. The mutants that ignore the age, reuse a failed result, or store the post-run fingerprint each fail a named row (RD5, DO3/DO4, DO6).
- V3: PL1 passes with 300 cases at seed `0x0a5e`. A pool of size 4 and a pool that leaks a slot on throw each fail it.
- V4: QT1 and PC1 pass under `bun run test`. With the pool bypassed in `defaultDiscoveryApi`, PC1 step 1 fails, and with the cache bypassed, step 2 fails.
- V5: On the live instance, before and after the change, with no OpenSpec edits for 10 minutes: one-second samples of `pgrep -fc 'openspec list --json'`, plus the `workspace_openspec_pass` lines after the change. Report the peak, the total runs, and the median pass duration. The after peak is 3 or less. Raw logs are kept.
- V6: `bun run check` passes on the clean committed tree.

### Excluded

- X1: Git discovery (`buildRepository`), its subprocesses, and how watcher events are scoped. They are measured in V5 only as context.
- X2: Inputs outside the fingerprint (a global `defaultStore`, registered stores, contents behind symlinked directories, same-size edits within one mtime tick). They are bounded by the 10-minute limit and are not guaranteed sooner.
- X3: Persisting the cache across restarts.
- X4: Removing stale worktrees.

## Closeout (proposed 2026-11-18)

### Current state (source pin `f52963d0`)

- Landed: `src/server/workspace/openspecFingerprint.ts`, `openspecDiscoveryCache.ts`, `openspecPool.ts`, and their wiring in `openspecDiscovery.ts` and `workspaceCoordinator.ts` (PR #384, `977db6a9`); the retention fix PR #411 (`09535dfc`). No production file of this change changed after `09535dfc`.
- Every scenario of both requirements carries a `@covers: openspec-visibility › …` annotation (8 scenarios, 9 annotations in `openspecDiscoveryReuse.test.ts`, `openspecFingerprint.test.ts`, `openspecPool.test.ts`, and `workspaceOpenspecComposition.integration.test.ts`).
- Mutant evidence for V1–V4 is recorded in tasks.md's implementation notes and the implementation task's result; it is a historical claim until the closeout reruns it.
- Open: tasks 1.1, 6.3, 6.4. 6.4 is the oracle map below. 1.1 and 6.3 (V5) are proposed for retirement.

### Proposed retirements (need the owner's approval)

| Item | Why it cannot be met now | Proposed disposition |
| --- | --- | --- |
| Task 1.1, V5 "before" half | The pre-change code no longer runs anywhere; a fresh "before" sample would measure the changed code. The only pre-change figures are the 2026-11-10 measurements in Why, which were not taken with 1.1's protocol. | Retire. Keep the 2026-11-10 figures as motivation only. |
| Task 6.3, V5 "after" half | It is a comparison with 1.1; without a baseline it proves no effect. It is also a live-instance probe, which planning cannot run. No spec scenario depends on it; the bound itself is covered by PL1 and PC1. | Retire. Claim no speedup or CPU-pressure result. |

If the owner declines, both stay open as owner-gated live evidence, and the change does not archive.

### Oracle evidence map

Literal titles below resolve today. A row marked *template* has no literal title at `f52963d0`: its test is generated by a loop (`openspecFingerprint.test.ts:212-216`, `openspecDiscoveryReuse.test.ts:47-48`, `openspecPool.test.ts:37`). Closeout task 7.1 replaces each loop with literal `test` calls whose titles equal the rendered template text, over the same row bodies, so the map can cite them.

| Oracle | Test | State |
| --- | --- | --- |
| FP1–FP11, FP13–FP15 | `src/server/__tests__/openspecFingerprint.test.ts`, rows rendered `${id}: ${variation} -> ${expected}` | template (7.1) |
| FP12 | `src/server/__tests__/openspecFingerprint.test.ts` › `FP12: no openspec/ anywhere up to the filesystem root, taken twice -> equal, and not null` | literal |
| RD1–RD4 | `src/server/__tests__/openspecDiscoveryReuse.test.ts`, rows rendered `${id}: previous …, fingerprint …, age … ms -> run/reuse` (RD1, RD3, RD4 have two rows each) | template (7.1) |
| RD5 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `RD5: a result exactly 10 minutes old is rediscovered even when the fingerprint matches` | literal (the template's two RD5 rows are unrolled too) |
| DO1 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO1: first discovery succeeds: one run, the entry stored with the pre-run fingerprint, the result published` | literal |
| DO2 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO2: a second pass two minutes later with an unchanged fingerprint runs nothing and publishes the cached result` | literal |
| DO3 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO3: a failed run after a cached success removes the entry and publishes last-valid values marked stale` | literal |
| DO4 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO4: the pass after a failure runs again with an unchanged fingerprint and stores the success` | literal |
| DO5 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO5: a missing-root payload is stored as an empty, non-stale result` | literal |
| DO6 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO6: a write during the run keeps the pre-run fingerprint, so the next pass reruns` | literal |
| DO7, A6 | `src/server/__tests__/openspecDiscoveryReuse.test.ts` › `DO7: a worktree the pass no longer lists runs nothing and its entry is dropped by the coordinator` | literal (also asserts the `workspace_openspec_pass` line per pass) |
| PL1 | `src/server/__tests__/openspecPool.test.ts`, title rendered `PL1: at most ${OPENSPEC_POOL_SIZE} run at once, … (${CASES} cases, seed 0x0a5e)` | template (7.1) |
| QT1 | `src/server/__tests__/openspecPool.test.ts` › `QT1: a run queued behind a full pool for longer than its timeout still succeeds when its process answers in time` | literal |
| PC1 | `src/server/__tests__/workspaceOpenspecComposition.integration.test.ts` › `PC1: 12 runs at most 3 at once, then none while unchanged, one after an edit, and all 12 after ten minutes` | literal |
| A5 (preserved behavior) | `src/server/__tests__/workspaceCoordinator.test.ts` › `isolates per-repository discovery failures`; `src/server/__tests__/workspaceCoordinator.test.ts` › `retains last-valid entry marked stale when a repository starts failing`; `src/server/__tests__/indexHandlers.test.ts` › `workspace snapshots reach clients on connect, discovery, and removal` | literal |

## Implementation contract

### Acceptance

- A1: Every oracle id FP1–FP15, RD1–RD5, DO1–DO7, PL1, QT1, and PC1 maps to at least one literal test title, and the repository's title resolver finds every cited title at the closeout head (zero unresolved).
- A2: The unrolled tests keep each row's inputs and assertions; each new title equals the text the old template rendered for that row, and the test count per file does not drop.
- A3: On the closeout head, the V1–V4 mutants named in the landed contract each fail their named row, with each mutant's script and log kept.
- A4: Tasks 1.1 and 6.3 and V5 read as the owner decided through plan approval (retired with this design's rationale, or still open and owner-gated); nothing claims a speedup or a CPU-pressure result.
- A5: Only after A4 records a retirement: the two ADDED requirements are synced into `openspec/specs/openspec-visibility/spec.md` byte-equal to this change's delta, and the change is archived; `specCoverageGuard.test.ts` passes with every ADDED scenario annotated.

### Invariants

- I1: No production file under `src/server/workspace/` or `src/server/bootstrap.ts` changes.
- I2: The existing `openspec-visibility` requirements in the main spec are unchanged by the sync.
- I3: No live-instance probe, timing measurement, or process sample is taken.

### Scope

- `openspec/changes/bounded-openspec-discovery/**`
- `src/server/__tests__/openspecFingerprint.test.ts`
- `src/server/__tests__/openspecDiscoveryReuse.test.ts`
- `src/server/__tests__/openspecPool.test.ts`
- `openspec/specs/openspec-visibility/spec.md`
- `openspec/changes/archive/**`

### Verification

- V1: A citation preflight (`parseCitation` plus `testTitles` over the cited files at the closeout head) reports zero malformed or unresolved citations for the map.
- V2: The three unrolled test files pass under `bun run test`, and each named mutant of A3 fails its row; logs kept.
- V3: `openspec validate bounded-openspec-discovery --strict` passes before the archive, and `scripts/__tests__/specCoverageGuard.test.ts` passes after it.
- V4: `bun run check --full-properties` passes on the clean committed closeout head under the pinned Bun, and `scripts/verify-result.ts` reports the head.

### Excluded

- X1: The live before/after measurement (tasks 1.1, 6.3, V5), proposed for retirement above.
- X2: Any change to discovery behavior, the pool size, the reuse limit, or the watcher.
- X3: The adjacent follow-ups (git fan-out and buffer work, task-415a0a8f) and the blocked timeout-fixture tasks; they are not dependencies.
