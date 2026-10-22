# Tasks

## 1. Runtime-read declarations

- [x] 1.1 Add the `@reads` header parser and the guard test (literal repository paths under `AGENTS.md`, `CLAUDE.md`, `docs/`, `.kawai/`, `.github/`, `openspec/` must be declared). Verify it with fixtures: an undeclared literal fails naming the file and path, a declared glob passes, and a temporary-directory path is ignored.
- [x] 1.2 Add `@reads` headers to every existing test file the guard flags, and verify that the guard passes over the whole suite.

## 2. Affected-test selection

- [x] 2.1 Add `scripts/affected-tests.ts`: staged-path classification; staged, unstaged, and untracked paths for runtime-read matches and escapes; the D1 disjoint declaration and `--changed` execution passes over exact fast-tier paths; and the D2 escape list (including `.bun-version`) switching to `bun run check` before classification. Unit-test it in a temporary repository with a leaf-module change, a docs change matched by `@reads`, a change nothing reaches (no tests), a lockfile or Bun pin change (escape), a rename/deletion, an unstaged runtime-read edit, and an empty candidate list. Verify runtime-only declaration matches execute without `--changed`, a test selected by both routes executes once, and either pass's failure fails the hook.
- [x] 2.2 Report the selection in the hook output: executed file count from JUnit reports, slow-tier candidates excluded, and when the escape fired. Verify the wording in the script's tests, including Bun's successful zero-affected run producing no JUnit file, a malformed report, stale-report prevention, and a failed child without a report.

## 3. Hooks

- [x] 3.1 Change `.githooks/pre-commit`: lint, typecheck, and the affected tests for source commits; lint, typecheck, and the `@reads` matches for docs-only commits; the full check on escape. Verify it with commits on a scratch branch: a one-module change runs only its tests in seconds, and an AGENTS.md edit runs the tests declaring AGENTS.md.
- [x] 3.2 Add `.githooks/pre-push` per D4 (record lookup by the pushed tree, a run when HEAD is that commit and the tree is clean, refusal otherwise, deletions skipped). Verify it in a temporary repository with a local bare remote, covering all push scenarios, including multiple refs on stdin, annotated tags, exact-key verification after a fallback, malformed/missing records, and deletion-only pushes. Verify partial checks never create a full-pass record.

## 4. Procedure and docs

- [x] 4.1 Rewrite AGENTS.md's Commands paragraph (fast commit hook, full check per result and push, `@reads`), and run `bun run test` once because tests read AGENTS.md.
- [x] 4.2 Rewrite the Checks bullet in `.kawai/groups/{junior,middle,senior}-devs.md` (commit freely without `suite-run`; `suite-run bun run check` on the clean committed tree before every `task_submit_result`, stating the outcome), and the check steps in `lead.md` and `reviewers.md` (`bun run check`, normally a recorded hit). Three-way merge against the live group files if the human edited them meanwhile. Verify with the group-catalog tests.

## 5. Integration check

- [ ] 5.1 For one week of real use after merge, compare the mean commit time and the hook's selected-file counts with the 2026-10-18/19 baseline (about 4 minutes per commit), and record the result in the PR or a process report.

## Workflow follow-up

- Owner: update user-level `~/.kawai/groups/reviewers-claude.md` and `reviewers-mimo.md` to `bun run check`; retire the memory note `dev-checks-commit-hook-is-the-check`.
- Archive after `check-dedup` and `parallel-suite` are archived.
