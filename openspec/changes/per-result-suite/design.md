# Design

## Context

- After `check-dedup`: `bun run check` runs lint, typecheck, and the full suite, and records a pass under a content key in `<git-common-dir>/kawai-checks/`. The hook delegates to it for non-docs commits.
- After `parallel-suite`: the runner runs files in parallel isolated workers, has a slow tier (`*.integration.test.ts` plus real-tmux), and can exclude it.
- Bun 1.4.3's `bun test --changed[=<ref>]`, checked in a scratch repository on 2026-10-19, follows imports transitively, sees staged, unstaged, and untracked edits, and exits 0 when it selects no file. It misses files a test reads at runtime: editing a `.md` file that a test `readFileSync`s selected 0 tests.
- Today the dev group files say a source commit "is your full check", tell devs to run `bun run test` before docs-only commits touching files tests read, and route every `git commit` through `suite-run`. Reviewers' and the lead's procedures re-run checks on results.
- On 2026-10-19, four commits were queued behind both slots for 23–33 minutes. One was docs-only and needed only lint and typecheck.

## Goals / Non-Goals

**Goals:**
- Per-commit cost in seconds for typical edits, with the selection decided by the code, never by an agent's judgment.
- Exactly one full check per handed-over tree, reusable by reviewers and the lead, and enforced at push.
- No slot needed for ordinary commits.

**Non-Goals:**
- Kawai verifying a result's check from the record (it would turn **(claimed)** test outcomes into recorded facts). That's a good follow-up for `task-results`, out of scope here.
- Choosing tests by area tags or agent judgment. Declarations are only for reads the import graph cannot see.
- Changing CI: it keeps the full non-real-tmux unit pass on every pull request; after `check-dedup`, coverage is push-only and docs-only PRs still skip e2e.

## Decisions

### D1. Selection = `--changed` ∪ `@reads` matches, minus the slow tier
`scripts/affected-tests.ts` classifies the commit from the staged paths, retaining the `docs-only-changes.sh` rule. For runtime-read matching and escape detection, it uses the union of staged, unstaged, and untracked non-ignored paths (NUL-delimited git output, renames disabled so both old and new paths count). This matches the working-tree scope of Bun's `--changed`, and the hook reports when unstaged or untracked changes contribute.

`bun test --changed` executes tests; it is not a list-only API. Use two disjoint passes through the runner, preserving its isolated environment and parallelism: first run the explicit fast-tier files matched by `@reads` without `--changed`; then, for source commits, pass the remaining fast-tier unit files as exact `./` paths with `--changed`. Do not pass `--changed` to the declaration-selected files: it would discard runtime-only matches. Skip either invocation when its candidate list is empty, since bare `bun test` would discover everything. Docs-only commits use only the declaration pass.

Report actual executed files from the machine-readable JUnit reports of both passes, plus the number of slow-tier candidates excluded; do not claim to know how many excluded slow files were import-affected. Bun's zero-affected exit is a success; test failures and report/selection errors fail the hook. Alternatives: a home-made import graph, rejected because Bun already ships one; parsing console output to discover tests, rejected because it is not a selection API.

### D2. Escape to the full check for graph-invisible paths
A fixed list (`scripts/test-runner.ts`, `scripts/check.ts`, `scripts/affected-tests.ts`, `.githooks/*`, `package.json`, `bun.lock`, `.bun-version`, `tsconfig*.json`, `bunfig.toml`, test preloads, `src/**/__tests__/helpers/**` when not imported) triggers `bun run check` instead. The record makes a repeat free. The escape is evaluated before docs-only handling and slow-tier exclusion.

### D3. `@reads` headers and their guard
The header is a comment in the first 20 lines, `// @reads: AGENTS.md, .kawai/groups/*.md`, with globs relative to the repository root. The guard test scans every test file for literal repository paths under `AGENTS.md`, `CLAUDE.md`, `docs/`, `.kawai/`, `.github/`, and `openspec/` that are not under a temporary directory (it ignores paths joined onto `tmpdir()` or `mkdtemp` results by matching only string literals that start at the repository root, or are joined to a repository-root helper). Any such literal not covered by the header fails, naming the file and the path. It is a heuristic and stated as one: it catches the common form, a literal path. A test that builds paths dynamically declares by hand, and review checks it.

### D4. Pre-push enforces the full check
Before running any check, read and buffer all pre-push stdin rows (a child check must not consume the remaining refs). For each pushed ref, skip deletions, peel lightweight or annotated commit tags with `<local sha>^{commit}`, and look up a record for that commit's tree under the current Bun version, platform, and architecture (the content key is defined over a tree id, so a committed tree matches a clean working tree of the same content). If it is missing: when the working tree is clean and HEAD is that peeled commit, run `bun run check`. Otherwise refuse, naming the commit and the command. Refuse a non-commit ref with an explicit unsupported-ref message. Deduplicate identical tree keys across refs. A successful fallback check must produce the exact pushed tree's full-pass key; partial affected-test runs never write full-pass records. `--no-verify` remains git's escape, governed by the same rules as for commit hooks.

### D5. Procedure: full check before every result
The dev group files replace "a commit is your full check" with: commit freely (the hook is fast and needs no slot), and before `task_submit_result` run `suite-run bun run check` on the clean committed tree and state the outcome. Reviewers and the lead run `bun run check` instead of `bun run test`, a hit when the dev already passed. `suite-run` stays for full checks, typecheck-heavy runs, client `.tsx` batches, builds, and e2e, and is dropped for `git commit`.

## Risks / Trade-offs

- [A regression that only a non-affected or slow-tier test catches lands in an intermediate commit] → It is caught at the result's full check, the push hook, or CI, before review or merge. The cost is one fix round, never a broken master.
- [A test reads a file through a computed path, invisible to both `--changed` and the guard] → The full check at result and push still runs it. The guard's heuristic is documented, and reviewers ask for headers.
- [An agent skips the per-result check and pushes] → The pre-push hook enforces it mechanically. Only a deliberate `--no-verify` bypasses it, which the existing rules govern.
- [Memory: commits outside the slot run lint, typecheck, and a few test files concurrently] → Typecheck dominates (incremental since `check-dedup`). If `memsample.log` shows pressure, the hook's test step takes a slot only when it selects more than a threshold of files.

## Migration Plan

1. Land the selection script, the `@reads` headers with the guard, and both hooks.
2. In the same PR, update AGENTS.md and the repository's group files. Running agents pick up group changes at their next start, and the hooks apply at the next commit.
3. Owner follow-ups outside the repository: the user-level reviewer groups, the lead's notes, and the memory note that records #214's rule.

Rollback: revert the PR. The hook then runs the full check again, and records stay valid. Archive after both prerequisites; the delta replaces `check-dedup`'s existing commit-hook requirement, rather than leaving its docs-only skip rule in force.
