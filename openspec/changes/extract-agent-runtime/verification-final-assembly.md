# Verification: final local assembly

Task task-3c3e3658, R2 (r2#6e6415164d6a). One writer in the final-assembly worktree. Bun 1.4.3 under suite-run for every install, check and hook. Controlled fakes only: nothing here is native 7.4, remote CI 8.3 or owner 8.4 evidence. This is a reviewed LOCAL candidate, not release acceptance.

## Inputs (A1, A2)

- `3f841622`: task-f5001d7f result-d8ef9a76 (remaining proof; PASS c9848c4e, full record c44203ab). Tree `70fe9bb5`.
- `53c56433`: task-dcd0c718 result-cdce1329 (Batch C consumer artifacts; Opus PASS 955a7cfd). Merge base with `3f841622`: `3093157c`.
- origin/master `72bed5e9` is an ancestor of `3f841622`.
- Preparation incident (A9): the Lead's fast-forward ran the existing dependency-change hook, which installed 708 packages with PATH Bun 1.4.4 outside suite-run. It left no tracked change and is not counted as evidence. Every install below is a pinned 1.4.3 frozen install.

## Merge reconstruction (A1)

- Merge commit `a6e4e952`, parents `3f841622` and `53c56433`, tree `8436986d`. That tree equals `git merge-tree --write-tree 3f841622 53c56433` and the pre-commit index tree.
- From the base, the remaining-proof side changes 109 paths and the C side 24. Only `bun.lock` changed on both sides; its diff against `3f841622` is the companion workspace version `0.0.0` -> `0.1.0`. Every other path keeps its one-sided blob.
- Stock hook: the lock and manifest escapes ran the full check, which passed and recorded `390bc88a` (merge-commit.log 6558ce33).

## Clean-archive dependency failure and the A10 helper (A10)

- In the archive below, `distribution.test.ts` failed in `beforeAll`: "Cannot find package 'undici-types' imported from packages/agent-runtime", at `helpers/packArtifact.ts` `consumerProject` (consumer-143.log 99bfc026). The other 18 cases in that run passed.
- Cause: undici-types is a dependency of @types/node only. Under the isolated workspace layout it is linked beside @types/node in `node_modules/.bun/`, never under the package. Worktrees passed only because resolution reached the ancestor `/home/coder/kawai/node_modules`. The helper blob `ba4124e4` is unchanged since the scaffold `7a914d0b`, in `3093157c`, both inputs and the earlier accepted archive, so the failure predates the assembly. It was disclosed before any edit (note 208cacc2), and the failed tree was not retried.
- A10 (Lead decision): `8aa72741` (tree `84e1c912`) changes only that function. It resolves undici-types from the resolved @types/node directory and keeps the three links, zod and @types/node resolution, consumer tsconfig (`skipLibCheck: false`), packed artifact, titles and assertions. There is no `.bun` path, fallback, dependency, manifest, lock or runtime change. Its stock hook ran 7 affected test files and passed (a10-commit.log 8e78dd0b).
- After the change, in the same archive: dist-free typecheck passed (tc-2.log c7a55078), and `distribution.test.ts` passed 6/6 (dist-2.log 2ebf934c, JUnit 7a78d2ca).

## Merged archive (A4, V3)

- /tmp/krp6/cand: a `git archive` of `8436986d` outside repository ancestry, `git init` with an empty hooks path. After A10 it is a scratch commit whose tree is `84e1c912`; ten tracked-but-ignored files were force-added so the tree matches exactly.
- `bun install --frozen-lockfile` with Bun 1.4.3: 708 packages. Lock `6e10615c` is unchanged, and no tracked path changed (install.log 80ebb410).
- No `dist` existed before the root `bun run typecheck`, which includes the package project; it passed (tc.log c7a55078).
- `bun run build` passed (root-build.log 7a57c149), and so did the package `bun run build` (pkg-build.log d322d355).
- Packed consumers at the current pin, 1.4.3: `consumerInstall.test.ts` 9/9 (stub alias/no-CLI install, no-SDK and Codex-free compile, packed headless example with both controlled providers, M-pack and missing-override negatives), `agentRuntimeRelease.test.ts` 4/4 and `affectedPackages.test.ts` passed (JUnit f1c72e7a). `distribution.test.ts` is covered by the A10 rerun above.
- Minimum supported Bun 1.3.0 (engines `>=1.3.0`), run like the release workflow's minimum-consumer job: `CONSUMER_BUN` set and the pinned 1.4.3 runner. `consumerInstall.test.ts` passed 9/9 (consumer-130.log b12ab8e0, JUnit 4ccd529c).
  - The 1.3.0 zip matches the official SHASUMS256 `60c39d92`, and the binary inside it is `70ce5810`.
  - A logging wrapper recorded 19 consumer calls, all reporting 1.3.0 (bun130-calls.log 59f2b746).
- Input equality for A10: `8436986d` and `84e1c912` differ only in the helper. It is a test file, so it is not an input of the install, typecheck project outputs, builds, `consumerInstall`, release or selector tests. Those stage results carry over by whole input equality, and the affected file was rerun.

## Isolated CI e2e (A5)

- Where: /tmp/krp6/cand at scratch tree `84e1c912` with the archive's own frozen install and root build (the A10 helper is not a client or server input). Both CI steps ran under suite-run with an empty private HOME (so a private DB), `CI=1`, tmux unset (the suite's own socket), spare ports 47312/47311, and `--workers=1`. `bun run test:e2e` and the human's server were not used.
- Main step: 110 tests, 27 passed, 83 skipped (the chat-fixture specs, as in CI), 0 failed (e2e-main.log 26c8c816).
- Chat-fixture step (the CI spec list): 67 tests, 66 passed, 1 failed (e2e-fixture.log f4410bb4). The failure is `plan-supervision.spec.ts:174`, which never shows the recorded 'Narrow' decision card.
- Baseline (A5): the earlier candidate `e34c9038` (tree `c59848f7`) had the same 27/83/0 and 66/1, and master `72bed5e9`, with its own install and build, reproduced the same :174 failure (verification-remaining-proof.md).
- Inputs: that spec, `tests/e2e/fixtures/`, `src/server/plans/`, `src/server/team/`, `src/client/`, `src/shared/` and `playwright.config.ts` are byte-identical between `72bed5e9` and `84e1c912`. All of `tests/`, `src/client/`, `src/shared/`, `src/server/chat/`, `src/server/plans/`, `src/server/team/` and package `src/` are identical between `c59848f7` and `84e1c912`; the assembly changes only manifests, the lock, examples, tests, scripts and docs.
- The one failure is the disclosed pre-existing baseline limitation, tracked as task fcbe74c7. Every other affected workflow passed. CI is not green.

## Coverage preflight (A6)

`/tmp/krp6/preflight.ts` (e0ed39b3) uses Kawai's `parseCitation` and `testTitles` against the current worktree. Every map citation and every `file` › `title` in this change's verification docs and tasks.md must resolve.

- Before the merge's stock hook (r1 map, 32 clauses): 0 missing, 53 map and 68 doc citations (preflight-1.log 45a63f30).
- After A10 (r2 map 190ce9ed, 33 clauses): 0 missing, 56 map and 68 doc citations (preflight-2.log e517efe7).
- It is rerun after these docs. A preflight resolves citations only; executed outcomes come from the result's checks.

## Controls (A8)

No control campaign was replayed (none of the five B, four remaining-proof or C controls). The regular negative tests ran normally: `consumerInstall.test.ts` › `D02 negative control: removing the required native platform override installs forbidden CLI contents`, `distribution.test.ts` › `control M-pack: a repository-relative import in a shipped file is reported`, and the release gate's nonzero-exit case. Package `src`, the host runtime and the public API are byte-identical to both inputs, so the accepted runtime controls keep their input sets.

## Not run

- CI's `deps:risk:ci` scan queries an outside advisory service. The merge changes no third-party lock entry: the only lock change is the workspace stub's own version.
- CI's coverage job and every remote workflow. The release workflow's verify job steps (frozen install, full check, package build, root build) and its minimum-consumer step ran locally above, plus the final full check at the result; no tag, dispatch or publication happened.

## Limits

- Controlled fake CLI and app-server only. Native 7.4, remote CI and assembled acceptance 8.3, and owner publication/access 8.4 stay open.
- The whole cross-model assembly review follows the result.
