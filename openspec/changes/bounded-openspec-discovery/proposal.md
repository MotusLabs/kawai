# Proposal

## Why

The Kawai server floods its own workspace with `openspec list --json` processes. On 2026-11-10, with 148 worktrees of one repository, the server (PID 406407) started 676 of them in two minutes, up to 235 at once, and a 20 s sample averaged 49 running. Each one is a Node process. Together they pin the workspace's 6-CPU quota (`cpu.pressure` some avg60 above 30%), slow every agent, and make the timing-sensitive tests in `bun run check` fail.

The cause is in the workspace discovery (`src/server/workspace/`). Every pass that rebuilds a repository runs the CLI once for each of its worktrees, all at once (`refreshRepositoryOpenSpec`, `Promise.all`), with no cache. The 30 s reconciliation forces a rebuild of every repository. A watched Git or worktree-root event rebuilds the whole repository too, even when it touched one worktree and no OpenSpec file. The coordinator's coalescing (one pass at a time) caps passes, but not the processes inside a pass.

## What Changes

- **Reuse unchanged results.** Before running the CLI for a worktree, discovery computes a stat fingerprint of what `openspec list` reads: the nearest `openspec/` root, the root's entries, and every file under its active change directories. When the fingerprint matches the last successful discovery for that worktree, and that discovery is less than 10 minutes old, the result is reused and no process starts. A failed or stale result is never reused.
- **Bound the processes.** All OpenSpec list runs go through one server-wide pool of 3. The 15 s timeout counts from the process start, not from the queue.
- **Report the work.** Discovery counts CLI runs, reuses, and the pool's peak, and the server logs them at debug level once per coordinator pass (`workspace_openspec_pass`), so the effect can be measured on a live instance. The workspace modules log nothing today.

Not changing: the snapshot shape, the watch targets, the 30 s reconciliation, the Git discovery, or how results are merged and kept as last-valid values.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `openspec-visibility`: adds two requirements, "Reuse unchanged OpenSpec discovery results" and "Bound concurrent OpenSpec discovery". The existing synchronization and failure-isolation requirements are unchanged and must keep passing.

## Impact

- Code: `src/server/workspace/openspecDiscovery.ts`, a new `src/server/workspace/openspecFingerprint.ts` and `src/server/workspace/openspecPool.ts`, and wiring in `src/server/workspace/workspaceCoordinator.ts`.
- Tests: `src/server/__tests__/openspecDiscovery.test.ts`, `workspaceCoordinator.test.ts`, and new fingerprint and pool tests.
- Operations: with no OpenSpec edits, a steady state of 148 worktrees runs at most 148 CLI processes per 10 minutes, at most 3 at a time, instead of 148 at once every 30 s.
- Related: `check-time-optimization` attributes check flakiness to CPU contention. This change removes the largest known source of that contention inside the workspace.
