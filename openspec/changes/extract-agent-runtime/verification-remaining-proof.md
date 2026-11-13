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

Exceptional generation teardown (task-7cfee843): no counterexample was found.

- The observation is in `terminateGenerations`. A rejected `owned.terminate()` rejects its `Promise.all` before the other generations' terminations settle, and it skips the `query.close()` loop.
- `terminate()` rejects only when a leader survives SIGKILL for `killMs` (5 s), or a group member survives the group SIGKILL for `killMs`. `killMs` is not a public option, and SIGKILL cannot be trapped, so no controlled provider reaches this branch.
- A respawn needs the previous leader's observed exit. So at most one live leader exists at a stop, beside retired groups that may still hold helpers; the I1's `crash`+`child` sequences exercise exactly that.
- In the branch, the stop rejects with the raw terminate failure and claims no receipt. Its jobs are still joined.
- What stays unproved is that a retired group's in-flight termination settles before such a rejected stop does. 2.2 stays unchecked for this one branch. A future correction that preserves the invariant would settle every termination (`allSettled`) and close every query in a `finally` before rejecting with every raw failure. That is a production edit; A7 leaves it to the Lead.

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

- Dead duplicates remain:
  - `src/server/chat/cliTurnBinding.ts` shares 149 of its 220 lines with the package's `claude/turnBinder.ts`. Only `cliTurnBinding.test.ts` imports it.
  - `src/server/chat/chatActivity.ts` shares 182 of its 258 lines with `common/activity.ts`. Only `chatActivity.test.ts` imports it.
  - Removing them and moving their cases to package construction is a production edit outside this task (X1). So 6.2 ("remove duplicate implementations") and 6.3 ("tests through package construction") stay unchecked.
- Retained host modules with package counterparts: `contentBlocks.ts` (transcript replay, approval policy, question deadlines) and `TurnQueue.ts` (the SDK availability probe and development fixture). The usage, Codex helper, transport and driver slices recorded under 6.3 stand.
- tool-call-metrics has not landed, so 6.3's preservation clause for it does not apply.

## Limits

- Controlled fake CLI and app-server only. Native 7.4, assembly 8.3 and owner 8.4 stay separate gates.
- The accepted five controls of batch B were not replayed. Only the M-join and M-wire controls ran here.
- The 2.2 exceptional branch above is argued from source, not executed.
