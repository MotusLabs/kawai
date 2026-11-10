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

## Implementation contract

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
