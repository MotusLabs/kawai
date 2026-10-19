# Proposal

## Why

Every source commit runs the full unit suite in the pre-commit hook. The 2026-10-18/19 measurement put that at 3.35 agent-hours: 49 commits at about 4 minutes each, plus their wait for one of the two memory slots. On 2026-10-19, four commits sat queued 23–33 minutes at once, one of them docs-only. The instruction to commit early and often makes the full suite per commit the most expensive habit the team has. The guarantee reviewers rely on is narrower: the tree a dev hands over as a result has passed everything. Intermediate commits need fast, mechanical feedback, not a certificate. The owner chose (2026-10-19) to move the full suite from every commit to every result and push.

## What Changes

- **BREAKING (team procedure):** the pre-commit hook no longer runs the full unit suite. For a source commit it runs lint, typecheck, and the affected tests only: the files reached from the changed files by imports (`bun test --changed`), plus files that declare a runtime read of a changed path. Slow-tier files are left out. A change the import graph cannot see (the runner, scripts, hooks, lockfile, package or TypeScript config, test preloads) still runs the full check.
- Test files that read repository files at runtime (AGENTS.md, `.kawai/groups/`, `docs/`, workflows, OpenSpec content) declare them in an `@reads` header. A guard test fails when a test names such a path without declaring it. Docs-only commits run the tests that declare a changed path, instead of the manual "run `bun run test` before touching AGENTS.md" rule.
- The full check (`bun run check`, cached by content key since `check-dedup`) is required at two points. Devs, before submitting a task result, by procedure in the dev group files. And a new pre-push hook, mechanically: a push is refused unless the pushed commit's tree has a recorded pass, or the clean working tree at that commit passes now.
- The commit hook needs no memory slot: devs run `git commit` directly, and only full checks go through `suite-run`.
- AGENTS.md's Commands paragraph and the repository's dev, lead, and reviewer group files are rewritten to the new rule.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dev-checks`: adds the per-commit affected-test check, `@reads` declarations with their guard, the full-check requirement at push, and how docs-only commits pick tests. The capability is introduced by `check-dedup`.

## Impact

- `.githooks/pre-commit`, new `.githooks/pre-push`, a selection script (`scripts/affected-tests.ts` or similar), and the runner's `--exclude-slow` path from `parallel-suite`.
- Test files gain `@reads` headers where they read repository files. A new guard test.
- `AGENTS.md`; `.kawai/groups/{junior,middle,senior}-devs.md`, `lead.md`, `reviewers.md`.
- Outside the repository (follow-up for the owner): user-level `~/.kawai/groups/reviewers-claude.md` and `reviewers-mimo.md`; the lead's `suite-run` usage notes and memory note `dev-checks-commit-hook-is-the-check`.
- Depends on `check-dedup` (`bun run check`, content key) and `parallel-suite` (slow tier). Lands last.
