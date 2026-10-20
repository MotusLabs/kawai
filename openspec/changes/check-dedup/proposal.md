# Proposal

## Why

Agents' measured turn time (about 20 agent-hours on 2026-10-18/19) spent roughly 35% waiting for checks: 3.8 h on lint, typecheck, tests, and e2e, mostly queued behind the two shared memory slots (`suite-run`, `suite.lock`), and 3.35 h in `git commit`, whose hook runs the full suite (49 commits, about 4 minutes each). Much of that work tests a tree that has already passed: the lead re-runs the suite on a dev's commit that the dev's hook just ran, a message-only amend re-runs it, and pull-request CI runs the unit suite twice (`test:ci`, then `test:coverage`). Every duplicate run also takes one of only two slots from someone else.

## What Changes

- New `bun run check` entry point running lint, typecheck, and the unit suite, which records a passing result under a content key: the working tree's content identity (tracked and untracked, non-ignored files), the Bun version, and the platform. A later check with the same key reports the recorded pass and runs nothing. Failures are never recorded. `--force` always runs.
- Results live in the repository's shared git directory, so every linked worktree, and the lead checking a dev's commit, sees the same record.
- The pre-commit hook goes through the same cache for its suite step, so committing a tree that already passed costs seconds.
- `bun run typecheck` becomes incremental, with its build info per worktree and ignored by git, with results identical to a clean run.
- Pull-request CI runs the unit suite once (`test:ci`). Pushes to master also run the coverage pass and upload its artifact. Coverage gates nothing today.
- `bun run test` stays uncached: it is what you run to see output again.

## Capabilities

### New Capabilities

- `dev-checks`: the local check pipeline agents and the hook use: what a check runs, how a passing result is recorded and reused across worktrees, and incremental typechecking.

### Modified Capabilities

- `github-workflows`: the quality-gates job runs the unit suite once on pull requests and adds the coverage pass only on pushes to master.

## Impact

- New: `scripts/check.ts` (or equivalent) and a `check` script in `package.json`.
- `.githooks/pre-commit`, `tsconfig.json` (incremental build info), `.gitignore`.
- `.github/workflows/ci.yml` (quality-gates job).
- Docs: the AGENTS.md "Commands" paragraph; the lead's procedure (`/home/coder/kawai-lead/suite-run` callers) switches suite runs to `bun run check`, outside the repository.
- Depends on `ci-bun-1-4` only for ordering; uses no Bun 1.4 feature.
- Precedes `parallel-suite` and `per-result-suite`, which reuse the content key.
