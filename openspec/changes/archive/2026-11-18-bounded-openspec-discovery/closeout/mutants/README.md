# Closeout mutant reruns (tasks 7.3, contract A3)

The landed contract's named mutants, rerun against the closeout head. Each
script patches one production file (its pattern must match exactly once),
runs the named row's test, writes `<name>.log` beside itself, and restores
the file in a `finally`. A mutant is *killed* when the named row's test
exits nonzero; a surviving mutant exits nonzero from the script.

Run all of them from the repository root:

```
for script in openspec/changes/bounded-openspec-discovery/closeout/mutants/V*.ts; do bun "$script"; done
```

The committed `.log` files are records of the runs performed at the closeout
head. The scripts' absolute `repo` path names this worktree; after the change
archives, the scripts live under `openspec/changes/archive/` but still target
the same checkout.

| Script | Named row(s) | File patched |
| --- | --- | --- |
| V1-size-dropped.ts | `FP3: tasks.md rewritten, different size, mtime restored -> differs` | openspecFingerprint.ts |
| V1-mtime-dropped.ts | `FP2: tasks.md rewritten, same size, new mtime -> differs` | openspecFingerprint.ts |
| V1-root-path-dropped.ts | `FP11: the worktree's openspec/ removed, so an ancestor's root resolves -> differs` | openspecFingerprint.ts |
| V1-archive-walked.ts | `FP8: a file under archive/ rewritten -> equal` | openspecFingerprint.ts |
| V1-root-entries-skipped.ts | `FP9: config.yaml rewritten -> differs` | openspecFingerprint.ts |
| V2-age-ignored.ts | the three `RD5` titles | openspecDiscoveryCache.ts |
| V2-failed-result-kept.ts | `DO3: a failed run after a cached success removes the entry and publishes last-valid values marked stale` | openspecDiscovery.ts |
| V2-post-run-fingerprint-stored.ts | `DO6: a write during the run keeps the pre-run fingerprint, so the next pass reruns` | openspecDiscovery.ts |
| V3-pool-size-4.ts | `PL1: at most 3 run at once, … (300 cases, seed 0x0a5e)` | openspecPool.ts |
| V3-slot-leaked-on-throw.ts | `PL1: at most 3 run at once, … (300 cases, seed 0x0a5e)` | openspecPool.ts |
| V4-pool-bypassed.ts | PC1 step 1 (peak overlap) | openspecPool.ts |
| V4-cache-bypassed.ts | PC1 step 2 (zero runs while unchanged) | workspaceCoordinator.ts |
| V4-timer-at-submission.ts | `QT1: a run queued behind a full pool …` | openspecPool.ts |
