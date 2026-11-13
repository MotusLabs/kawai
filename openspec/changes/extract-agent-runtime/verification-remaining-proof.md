# Verification: remaining Claude ownership and Kawai package wiring

Task task-f5001d7f, R2 (r2#0b80c5f97272). Bun 1.4.3. Controlled fakes only: nothing here is native 7.4 evidence. Package src, host runtime, the public API, the manifest and the lock are unchanged; every change below is a test or fixture.

## Merge (A1, A10)

`9748e004` merges origin/master `72bed5e9` and accepted `067dd5d0`, so both histories are preserved. Exactly three files differ from both parents:

- The two auto-merged tests, `taskListTools.test.ts` and `teamWaitingReasons.integration.test.ts`. Each is byte-identical to a fresh three-way `git merge-file` of its base and sides.
- The one authorized exception (A10), in `codexTransport.test.ts` › `a duplicate reply and a reply after the deadline settle nothing; timers are cleared at settlement`.
  - Before its subject request and timer spies, `f` sends the existing `never` notification. It then waits, within the harness's existing `until` bound, until the child's transcript shows it. The notification has no id and gets no reply.
  - Request ids, counters, the 1000/10/40/120/30 ms values, the `g` half and every assertion are unchanged.
  - The earlier merge hook run failed this case with "app-server request 1 (late) had no reply within 1000 ms". That proves only that no reply came within 1000 ms; no cold-start or load cause was proved.

Every other file has its one-sided blob. The first hook run failed only on missing dependencies: the new worktree had master's lock and no SDK or bun-types. `bun install --frozen-lockfile` corrected that. Both failed hook logs are kept.

## 2.2: Claude ownership

`claudeStopOrder.test.ts` is the Claude I1. It uses the generator, seed (0xA601), 300 sequences and operation list of `codexStopOrder.test.ts`, through the public `createClaudeDriver`, the pinned SDK, the owned spawner and the fake CLI.

The sequences issue these operations without awaiting them:

- turns, held turns, and `queue` sends (Claude's one continuation stands in for the generator's `steer`);
- interrupts;
- crashes and restarts, which put a new generation beside the retired one;
- a late `child` helper left in the CLI's process group;
- held host tool handlers and waiting `Edit` permission requests;
- a kill or shutdown at a seeded point.

At stop settlement the oracles are those of the Codex I1:

- every recorded leader and helper is gone (a zombie counts as dead);
- no started handler is unfinished;
- a resolved receipt reports every spawned leader as exited;
- every accepted handle settles, and no turn result is reported twice.

A rejected stop must come from a `crash`, with category `stop`. Its causes may be only the fixture's exit code 3: the native exit, which must be present, and the SDK's read failure for it.

Cleanup is one `ownedAggregate`. Each sequence's entry is admitted before its driver exists. The join is the sequence's own stop, then the removal of its root (last). Raw failures are reported in order. Only one occurrence of the exact value a sequence asserted is consumed.

- Literal slices `Claude I1: the stop settles only after every owned process exited and every admitted handler finished (sequences 0-4)` through `(sequences 295-299)`, in order.
- `claudeStopOrder.test.ts` › `Claude I1: every sequence spawned its CLI, and the sequences reached helpers, handlers, requests and a crash-caused rejection`
- `claudeStopOrder.test.ts` › `Claude I1: the 300 sequences reach every operation, and both stop modes`

Fixture corrections, found by the I1's first full run (15 of 60 slices red):

- `child` starts a helper in the CLI's own process group that outlives the CLI.
- The fake's interrupt result now carries `errors: []`. The pinned SDK's `SDKResultError` always has `errors`, and its reader evaluates `e.errors.map` on every error result. Without the field the reader threw a TypeError, the generation ended, and the stop rejected with that TypeError.
  - `claudeStopOrder.test.ts` › `the interrupted turn settles as interrupted, the generation keeps reading, and a kill resolves with its one exit` pins it.
  - Against the old fixture line it fails, 0 pass / 1 fail: the SDK's TypeError ends the generation and the `after` send is refused (/tmp/krp/oldfixture.log, sha256 78876f9a7b7f0afa28c8736f14a3aef7c936cbcdff47580531b91952f6e9fb96).
  - The first form of this regression interrupted before the fake had read the turn and passed against the old fixture; it now waits for the turn's prompt first.

Control M-join (A4), at the Claude ownership boundary. Both sources were restored and sha-verified afterwards:

- The mutant makes `toSpawnedProcess` report exit at stdout EOF (the exit event and `exitCode` 0). It also makes the generation's consume job stop awaiting `leaderExit`.
- `claudeSession.test.ts` › `M-join: a CLI that closes its stream but keeps running is not reported as exited` fails on a value: state `exited`, expected `active`. `L14: a crash mid-turn reports one process end and one process-ended result; start respawns` fails on its reported end: code 0 at EOF where the crash exited with code 3. Logs: /tmp/krp/mjoin-session.log (sha256 b2ed576beafd69606e6bd7fd69bd8adc6e33144673bf9f89cbc836b426b61994); diff /tmp/krp/mjoin.diff (132db3db235c5ef8d76899832b8579db5f5f93cf8fdba6aa251934f6129ca102).
- Disclosed: a first form that emitted only the exit event was equivalent for the M-join witness. Its two kills were 20 s timeouts, which are not evidence (/tmp/krp/mjoin-v1-session.log).

Exceptional generation teardown (task-7cfee843). No controlled public provider reaches this branch; R3's internal-boundary unit (A12, below) then demonstrated the gap.

- The observation is in `terminateGenerations`. A rejected `owned.terminate()` rejects its `Promise.all` before the other generations' terminations settle, and it skips the `query.close()` loop.
- `terminate()` rejects only when a leader survives SIGKILL for `killMs` (5 s), or a group member survives the group SIGKILL for `killMs`. `killMs` is not a public option, and SIGKILL cannot be trapped, so no controlled provider reaches this branch.
- A respawn needs the previous leader's observed exit. So at most one live leader exists at a stop, beside retired groups that may still hold helpers; the I1's `crash`+`child` sequences exercise exactly that.
- In the branch, the stop rejects with the raw terminate failure and claims no receipt. Its jobs are still joined.

Package-source exception (R4 A12/A13; disclosed here before the edit). R3's A12 ran the actual `terminateGenerations` from package tests. Generation 1's `owned.terminate()` rejected, a contract-valid outcome: a stop error `agent process 101 did not exit after SIGKILL`. Generation 2's terminate was held.

- Old behavior, observed: the function rejected with the raw failure (same identity) while generation 2's termination was still in flight. It closed no query, either at settlement or after the release. The probe is /tmp/krp3/claudeTerminateGenerations.test.ts (sha256 960b0cf14a5cba8c31371df0bfdad73b87c5a0df21be216f449bed761d25921a) and failed 0 pass / 1 fail; log /tmp/krp3/a12-probe.log (bfa104e4380fb96abfb48d0eee074aefa01289b996fdb0f0b37926f377f34ee4); post-release observation /tmp/krp3/a12-post.log (99a8f0bad6123bf366f27f46da5d03701c9f7d4ffa98d5973bd5509f7c50174e).
- The cause is that `Promise.all` over the owned terminations rejects at the first failure, before the query-close loop runs.
- A focused read-only assessment (task note f2112c41) found the correction aligned. The Lead published it as A13; it is the batch's only package-source change.
- New behavior: only `terminateGenerations` and its header change.
  - Marks, aborts, input ends, shutdown grace and bounds are unchanged.
  - Every owned termination is started in supplied order, and all of their outcomes settle.
  - Then `query.close()` is attempted for every generation, including an ownerless one and one whose terminate rejected. The existing catch-and-ignore of a close throw is unchanged.
  - Outcomes are classified by status, so a rejected `undefined` or `null` still counts as a failure. With no failure, the same facts are returned, sorted by generation. With one failure, the original reason is thrown unchanged. With several, the existing `AgentRuntimeError` (category `stop`) is thrown, its `causes` holding every original reason in supplied order, with duplicates and nested errors intact.
- `lifecycle.runStop` is unchanged. It keeps the thrown value as one outer cause, then joins jobs and runs the account, as before.

Implemented in `d01a0479` (`generations.ts` only: the `terminateGenerations` body and its doc comment). Its regressions on the actual function, all passing:

- `claudeTerminateGenerations.test.ts` › `the stop settles only after the held peer termination, closes every query, and rejects with the one raw terminate failure` is A12's probe, committed. It asserts the stop is pending and has closed nothing before release, then closes every query and rejects with the same failure object.
- `claudeTerminateGenerations.test.ts` › `several failures completing in reverse, supplied out of numeric order, reject once with every raw reason in supplied order`. Generations are supplied as 3, 1, 4, 2, 5 and complete in reverse. The reasons are a nested `AgentRuntimeError`, one raw object twice, `undefined` and `null`. The causes match per index (`toBe`) in supplied order, and the nested error keeps its own cause.
- `claudeTerminateGenerations.test.ts` › `exactly one rejection with an undefined reason throws undefined, judged by status`.
- `claudeTerminateGenerations.test.ts` › `marks, aborts, ends input, terminates and closes in order, attempts every close past a throwing one and an ownerless one, and returns the same facts by generation` is the zero-failure control, with the same fact objects, sorted.
- No existing Lifecycle test combined a teardown rejection with a held job and the account. `lifecycle.test.ts` › `a teardown that throws an aggregate still joins a held job and runs the account, keeping the aggregate as one cause` adds that one case; `lifecycle.ts` is unchanged.
- Public stop paths, at d01a0479's tree before its commit: `claudeStopOrder.test.ts` (the I1, all 60 slices), `claudeSession.test.ts`, `claudeReentrantStop.test.ts`, `claudeDriver.test.ts`, `lifecycle.test.ts` and the new file, 213 pass / 0 fail (/tmp/krp3/a13-tests.log). The commit's stock hook then ran 1518 affected tests across 139 files, all passing.

With the I1, the M-join control and this branch now proved at its internal boundary, 2.2 is checked. Native SIGKILL survival itself is still never induced (limit below).

## 6.1: Codex host composition

`createChatDriver.test.ts` runs the codex record through `createChatDriver`, `codexRuntime.ts` and the public package factory to the replaying fake app-server. The inputs are Kawai's: the project inside a Git repository, model, network, system prompt, team tools, stored thread and wire.

- `createChatDriver.test.ts` › `a fresh codex chat sends its caller-defined cwd, model, prompt, team tools and sandbox policy on thread/start, over the wire it recorded`
- `createChatDriver.test.ts` › `a stored codex chat resumes its own thread with the caller-defined cwd, model and prompt, and starts none`

Control M-wire (A5). `innerOptions` hands the package a bare, valid option set: Kawai's launch and logger, a fixed workspace-write policy without the per-spawn roots or network, and the callbacks. It drops the resume, model, prompt, team tools, wire, audit, skill and thread-open wiring.

- The fresh witness fails on values: every caller-defined field is `undefined` and no tools are sent.
- The resume witness and the two `codexSandbox.test.ts` cases fail only by their `until` bound, which is not evidence.
- The source was restored and sha-verified. Log: /tmp/krp/mwire.log (087d9860665a012065709caa41cb193d94a695a3f302039a811f2817742490ba); diff /tmp/krp/mwire.diff (7f02a4db0a5f8f0d30d72c7ef81e10ed38fb67403e9f62c74f18867b8d3e1d83).

With Claude's batch B M-wire (`claudeRuntimeLaunch.ts`), both runtimes' production-composition boundaries now have a value-failing control. 6.1 is checked.

## 6.2/6.3 reconciliation

Current merged sources, against the slice results recorded under 6.3 in tasks.md:

- Dead duplicates retired (R3 A11, `0f1aec42`):
  - `src/server/chat/cliTurnBinding.ts` was byte-identical to the package's `claude/turnBinder.ts` apart from the package's provenance header line. `src/server/chat/chatActivity.ts` was byte-identical to `common/activity.ts` apart from that header and one type import: the package aliases its own `Activity`/`ActivityPhase`, which are structurally identical to `src/shared/chat.ts` `ChatActivity`/`ChatActivityPhase`. (R2's "149 of 220" and "182 of 258 shared lines" were miscounts.)
  - Their only importers were their own tests. Both were moved with `git mv` to `packages/agent-runtime/__tests__/claudeTurnBinder.test.ts` and `activity.test.ts`. The diff is a three-line header plus the import paths, now `../src/claude/turnBinder.js` and `../src/common/activity.js`.
  - Old/new bijection: identical titles, bodies and order; 20 tests with 71 `expect(` calls, and 15 with 34. There is no semantic gap and no oracle changed.
  - The current citations in `docs/architecture/chat.md` and `docs/claude-cli-contract.md` name the package files. The `docs/refactor-analysis/` tables and the separate `process-observability` change keep their historical mentions.
- Retained host modules with package counterparts: `contentBlocks.ts` (transcript replay, approval policy, question deadlines) and `TurnQueue.ts` (the SDK availability probe and development fixture). The usage, Codex helper, transport and driver slices recorded under 6.3 stand.
- tool-call-metrics has not landed, so 6.3's preservation clause for it does not apply.

Row controls (R4 A14), each run on the final relevant inputs (HEAD `d01a0479`) by /tmp/krp3/mutants4.py (sha256 5dd0350f3d09506492b1e53f55242016cc387971c345480de6e497c6eb7ac041). Each mutation replaces one unique span; the source was restored from its saved copy and sha-verified, leaving the tree clean.

- Peer/context enrichment (6.2): Kawai's `claudeRuntime.ts` passes `composePrompt: () => undefined` in place of `promptEnvelope`. This kills, on values, three tests: `chatWorkspaceSend.test.ts` › `a contextual send records, then opens, emits, and enqueues with the context pasted` and › `I3 a slash command keeps its literal text and still dispatches with the context pasted` (`pasted_content` is `undefined`), and `chatSessionDriver.test.ts` › `peer delivery pushes a peer-origin turn and emits display metadata without a user copy` (`origin` is `undefined`). 145 pass / 3 fail. Log /tmp/krp3/enrich.log (8f09bb6a69c92b15a134aee6c6e8a9f49db581167e3ca850ddd405cd11221b96); diff /tmp/krp3/enrich.diff (bae4e2958f8af646b01af426df176c307473bd675b8d2e8da58c3dd5973de9ca).
- Binder bypass (6.3): the package's `resultSettlement.ts` settles the active turn without the binder's verdict. The production-path `chatSessionDriver.interrupt.test.ts` gives 10 pass / 13 fail, every kill on a value (no timeout). For example, `GUARD (2b1f56bf) (ii) a never-sent uuid is logged and dropped` expected `working` and got `waiting`. Others are `GUARD (2b1f56bf) (i) a late or duplicate result naming a completed turn never closes the current one` and the three recorded-contract probes. Log /tmp/krp3/binder.log (1401dee1db9a2857639c726e8e28d83c653fd389e742fe1070dea20bed68b8bd); diff /tmp/krp3/binder.diff (28355a3da5bf8067c219adbd6f10e85a5ce5b862ec309dad6729074de2b9b661).
- M-pack (6.2) was not replayed. The decceb record holds `distribution.test.ts` › `control M-pack: a repository-relative import in a shipped file is reported` and › `control: the clean project cannot resolve a Kawai type for a consumer`, both passed. They tamper with an installed real tarball copy, and both run again in this batch's final full check.
- The policy M-wire half of 6.3's control is batch B's Claude control plus this batch's Codex control (6.1 above).

6.2 and 6.3 are checked: no duplicate implementation remains, the slices' moved cases run against package construction or the package modules, and every named control fails on values.

## Merged dependency resolution (R5 A15)

Running the final A8 stages outside the repository's ancestry found a merged-baseline gap.

- Setup: a dist-free `git archive` copy of `ba5a78ad` under /tmp, with this worktree's frozen `node_modules` linked entry by entry, so no ancestor `node_modules` could be reached.
- Root `tsc --noEmit` failed with TS2307 "Cannot find module 'mdast'" at `src/server/plans/workspace/checklistProjection.ts:18` (/tmp/krp3/root-tc.log, sha256 4e1ab469fff278f8a8e798fd84a6bb1a31de47b8c6714b3013d20fab177dd9c0).
- Root `bun run build` failed: Rolldown cannot resolve `workbox-window` from `virtual:pwa-register` (/tmp/krp3/root-build.log, 43e90106402cc6f2bab187770009e7d5c1503e208ddc245f2c938b92d71aa5aa).
- The package typecheck and build passed.

Ancestor masking: in the worktree both stages passed. `--traceResolution` showed `mdast` resolving to `/home/coder/kawai/node_modules/@types/mdast`, the main checkout's install above the worktree, not the worktree's own.

Cause:
- Master (`72bed5e9`) imports types from `mdast`, and `vite-plugin-pwa` needs `workbox-window`. Neither is a declared root dependency.
- Accepted `067dd5d0` adds the root `workspaces`, so the merged install uses Bun's isolated layout. There both packages sit only under `node_modules/.bun/` (`@types+mdast@4.0.4`, `workbox-window@7.4.0`).
- Master's hoisted install exposed them at the top level.

Correction (Lead decision A15):
- `package.json` gains the root devDependencies `"@types/mdast": "4.0.4"` and `"workbox-window": "7.4.0"`, the versions already locked.
- `bun install` with Bun 1.4.3 changed `bun.lock` by exactly those two declaration lines in the root workspace block (diff /tmp/krp3/lock.diff, sha256 ba4a3226396fbe0a78e743db3eda39318e7b1a268d35cf1e66296e0aee71b67e). No package entry, resolution, integrity, override or workspace changed.
- The linker, config and sources are unchanged.

Independent candidate validation (same content: `git archive ba5a78ad` plus the staged `package.json`, `bun.lock` and this file, under /tmp/krp4/cand, `git init`, no ancestor `node_modules`):
- Bun 1.4.3 `bun install --frozen-lockfile`: 708 packages, `bun.lock` byte-identical after (install.log 5a1346dc).
- Dist-free `bun run typecheck` (root then package) passed (tc.log c7a55078); root `bun run build` passed (root-build.log 299d0682); package build passed (pkg-build.log d322d355).
- `@types/mdast` resolves to the copy's own `node_modules/.bun/@types+mdast@4.0.4`.

## Stock-commit failures and the amend fixture precondition (A16, A17)

- First stock commit of the staged A15 tree (a15-commit.log, sha256 3f0784f468970b101f004ce1dbe33106986f7a9c0caa4b5471c557690c996a9a): `checkKey.test.ts:121` key changed after an ignored write, and the I3 amend case timed out (20075 ms). Running the two files alone passed 37/0 (a15-diag.log b1b6b77a); diagnostic only.
- A16, the one authorized unchanged retry (/tmp/krp4/a16-commit.log, b454b1219f0758b091bae23fb32d40e31477acdc705f0b395e1be58627685401): 10883 pass, 2 fail. Both amend cases timed out (20056 and 20022 ms, nested amend code -1); `checkKey` passed this time, which proves nothing about its shared defect (task 3b3653c9, not adopted). Neither commit landed.
- The cause of the timeouts is unknown: no load or cause attribution is claimed.
- A17 changes only the setup of the two amend cases in `scripts/__tests__/preCommitHook.integration.test.ts`. Old: stage an unrelated `src/shared/lone.ts` edit and make a hooked setup commit, then check and amend. New: amend `createHookRepo`'s own initial commit, as the accepted R3 unreadable-record case already does.
- Equivalence: the constructor's checked `git commit` leaves a clean index equal to HEAD, the precondition the setup commit built. The real `fixture.check()`, record snapshot, amend and every title, message and assertion stay inside the same 20 s case; I3's unstaged `bun.lock` write is unchanged. Each case adds an unchanged `HEAD^{tree}` assertion after the amend. Helpers, hook and the other cases are unchanged.

Outcome: the A15+A17 stock commit `e34c9038` (tree `c59848f7`; first landed as `de049396`, then a message-only subject amend) passed its hook's full check, 10885 pass / 0 fail (/tmp/krp4/a17-commit.log 873ea6f4). The affected file alone ran 18 pass / 0 fail (a17-tests.log 937017fd); the runner prints no per-case times.

## Isolated CI e2e (A8)

- Where: the /tmp/krp4/cand copy committed in its own scratch repository, with tree `c59848f7` equal to `e34c9038`'s; its own frozen install and the build above. Both CI steps ran with an empty private HOME, CI=1, the config's private tmux/DB, spare ports 47312/47311 and workers=1 (/tmp/krp4/e2e.sh).
- A first run in an uncommitted `git init` copy is void: specs that branch the suite's own repository failed with "not a valid object name: 'master'" (run1 logs 788494eb, 8294f3cf).
- Main step: 110 tests, 27 passed, 83 skipped (the chat-fixture specs, as in CI), 0 failed (e2e-main.log 26c8c816).
- Chat-fixture step (the CI list): 67 tests, 66 passed, 1 failed: `plan-supervision.spec.ts:174` never shows the recorded 'Narrow' decision card (e2e-fixture.log eb71d801).
- Baseline: the same spec alone in a clone of master `72bed5e9` with its own frozen install and build fails identically (base-supervision.log 49e74729). The failure predates this batch and is not repaired here; its cause is not investigated.

## Limits

- Controlled fake CLI and app-server only. Native 7.4, assembly 8.3 and owner 8.4 stay separate gates.
- The accepted five controls of batch B were not replayed. This task ran four controls: M-join, Codex M-wire, enrichment and binder.
- The 2.2 rejection branch is proved by the actual-function units with contract-valid rejections. A native leader or group surviving SIGKILL is never induced.
- Correction to result-18442434: its full record `decceb030c2dce03b307fcdb42e42e80b374a67e3152acd4c6613e3739d79736` (exact head `7895c674` only) does hold per-test outcomes for the package suites. It has 10903 outcomes, all passed, 1048 of them under `packages/agent-runtime/` (including 63 from `claudeStopOrder.test.ts`). The result's claim that package suites are absent from the root record was false.
