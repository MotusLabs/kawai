# Design

## Context

- `.githooks/pre-commit` runs `bun run lint`, `bun run typecheck`, and, unless `scripts/docs-only-changes.sh` classifies the staged paths as docs-only, `bun run test` (`scripts/test-runner.ts`: one main `bun test` process plus about 33 one-file processes).
- A timed run on 2026-10-19 took 411.8 s for the main batch and about 30 s for the rest (5051 tests, 449 files). Every heavy command is serialized through two memory slots (`/home/coder/kawai-lead/suite-run`; slot 1 is `suite.lock`) because the workspace has 12 GiB and OOM-group restarts.
- Linked worktrees share one git common dir (`git rev-parse --git-common-dir`).
- `tsconfig.json` has `noEmit: true` and no incremental settings.
- `ci.yml`'s quality-gates job runs `test:ci` and then `test:coverage`. Coverage is printed and uploaded, and gates nothing.

## Goals / Non-Goals

**Goals:**
- Never run the same checks twice on the same content, in any worktree.
- Make repeat typechecks cheap.
- Halve pull-request CI's unit-suite time.

**Non-Goals:**
- Changing when the full suite is required. Per-commit stays as today; `per-result-suite` changes it.
- Making the suite itself faster (`parallel-suite`).
- Caching e2e runs or individual test files.
- Changing `bun run test`, which stays the uncached, raw runner.

## Decisions

### D1. Content key = working-tree tree id + Bun version + platform
Compute the working tree's tree id without touching the real index: copy the current index file to a temporary path, run `git add -A` and then `git write-tree` with `GIT_INDEX_FILE` pointing at the copy, and delete the copy. Copying the index keeps git's stat cache, so this is fast on an unchanged tree. The key is `sha256(treeId, Bun.version, process.platform, process.arch)`.
- The test runner, scripts, `bun.lock`, and `package.json` are all part of the tree, so editing any of them changes the key.
- Ignored files (`node_modules`, `dist`, `coverage`) are not part of the key. The risk is a stale `node_modules`; see Risks.
- Alternatives: the HEAD commit id, rejected because it misses unstaged and untracked work and differs between an amend and its original. Hashing every file ourselves, rejected because git already does it, faster.
- Inside the pre-commit hook git exports `GIT_INDEX_FILE` for the commit's index. The key computation sets it explicitly for its own calls and never passes it on. The check also clears it (and the other `GIT_*` hook variables) from the environment it gives lint, typecheck, and the suite. Tests that spawn git already use `cleanGitEnv`.

### D2. Records live in the shared git directory
`<git-common-dir>/kawai-checks/<key>.json` holds `{ key, treeId, bun, platform, at, worktree, steps: [{ name, ms }] }`, written to a temporary name and renamed into place. Every linked worktree resolves the same directory, so the lead's check of a dev's content hits the dev's record. Records older than 14 days, beyond the newest 500, are pruned at each write.
- Alternative: a `.cache/` directory per worktree, rejected because cross-worktree reuse is the main saving. Another alternative is the user's home directory; it would also work across clones, but nothing needs that.

### D3. `bun run check` owns the cache; `bun run test` stays raw
`scripts/check.ts` computes the key. On a hit it prints `check: recorded pass <time> in <worktree>` and exits 0. On a miss it runs lint, typecheck, and `bun run test` in order and records a pass. `--force` skips the lookup. Concurrent checks of the same key both run; that's harmless, as the last rename wins.
- Alternative: cache inside `bun run test`, rejected because people run `bun run test` precisely to see output again, after a flake for example.

### D4. The hook delegates to the check
For a docs-only commit the hook keeps running lint and typecheck, with no suite. Otherwise it runs `bun run check`, so a hit skips all three steps. The key covers the working tree, which is what the suite has always tested in the hook. The rare commit made with unstaged changes keeps today's semantics.

### D5. Incremental typecheck
`tsconfig.json` gets `incremental: true` and `tsBuildInfoFile: node_modules/.cache/kawai/tsc.tsbuildinfo`. That path is per worktree and already ignored, and `tsc --noEmit --incremental` is supported. TypeScript invalidates the build info when inputs or options change, and diagnostics equal a clean run's.

### D6. CI unit suite once on pull requests
The `Test (coverage)` and `Upload coverage artifact` steps run only on `push`, through `if: github.event_name == 'push'`. `test:ci` stays on both events. `test:ci` also covers the isolated files, which the coverage run skips, so it is the one to keep.

## Risks / Trade-offs

- [Stale `node_modules` or a changed global tool, such as tsc in the workspace, behind an unchanged key] → `bun.lock` and `package.json` are in the tree, and `node_modules` follows them through `bun install`. `--force` remains for doubt, and CI still runs everything on a clean install.
- [A flaky test that passed once is "cached green"] → A pass is a pass today too. The record makes no claim beyond "this content passed once". CI re-runs everything.
- [Anyone can write a fake record in the git dir] → Records are a speed aid among cooperating local agents, not a gate. CI is unaffected.
- [Hashing a huge untracked file (a log, an extract) in the key] → `git add -A` on a temporary index costs about the same as `git status`. Keep large scratch output under ignored paths, as today.
- [Losing coverage visibility on pull requests] → Nothing reads it there. Master pushes keep the artifact.

## Migration Plan

1. Land `scripts/check.ts`, the `check` script, the hook change, the tsconfig settings, and the CI step condition together.
2. Update AGENTS.md's Commands paragraph to name `bun run check`.
3. After merge, the lead switches its procedure from `bun run test` and `typecheck` to `suite-run bun run check`. That lives in the lead's own files.

Rollback: revert the commit. Records left in the git dir are inert.
