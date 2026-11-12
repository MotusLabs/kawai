# Verification batch B: proof audit, Codex stop order, cross-host resume

Task task-6efaf29b R3 (r3#1e172d132eaf). Base: accepted 3093157c (task-ce05430a DONE). Test commit: 36089de6. Bun 1.4.3. Package src, the public API and production code are unchanged. Controlled fakes only: nothing here is native acceptance (task 7.4).

## U2: Codex stop order (task 4.2, I1)

Historical input: result-adcca8f2 (9f8f57ab) had one red run of slice 75-89 ("liveAtStop one pid") with an unknown cause. Its later run, and every run since, passed.

Diagnosis, from bounded probes over the same generator (out-of-tree copies of `codexStopOrder.test.ts`, never committed):

1. The cold-start describe never reaches a booted app-server. Each of the 300 sequences ran `starting>stopping>stopped`. Each had one generation, SIGTERMed before the fake ran, and recorded no pid. So in this environment the cold I1 covers only the window from creation to generation start.
2. The same seeds after an awaited `start()`: 300/300 verdicts were clean, and every sequence booted its app-server. 48 sequences left a `/child` helper in the group. 37 stops rejected, every one with exactly one cause, `transport:agent process generation 1 exited with code 5 (before the stop|after the stop began)`: the crash's retained native exit, by design.
3. In 2/300 sequences (68 and 132) a recorded pid answered `kill(pid, 0)` at stop settlement while `/proc` showed it as `Z`. Both were `/child` helpers that outlived their leader. They are reparented to the container's PID 1 (`coder agent`), which does not reap them promptly. The pre-a16ac4ac harness `alive()` used only signal 0, so it counted such a zombie as live. Slice 75-89 does contain sequences that spawn `/child` before their first stop (75, 78, 79, 80).

Conclusion: a harness artifact, not a production flaw. Production's `processGroup.liveGroupMembers` already counts `Z`/`X` as dead. The historical pid itself was not recorded, so its attribution rests on this class reproduction, not on identity.

Committed evidence:

- `zombieLiveness.test.ts` › `an unreaped exited process answers signal 0, yet alive() and the production group check count it dead`
- `codexStopOrder.test.ts` keeps its cold describe verbatim (seed 0xA601, 300 sequences, 20 slices of 15), with `I1: the 300 sequences reach every operation, and both stop modes`. It adds `I1 after readiness: the stop settles only after every owned process exited and every admitted handler finished (sequences N-N+4)` (60 slices). Each rejected stop must be exactly that one crash cause. It also adds `I1 after readiness: every sequence booted its app-server, and the sequences reached helpers, handlers and a crash-caused rejection`.

## U3: cross-host resume (task 4.4)

`crossHostResume.test.ts`, through `fixtures/crossHostDriver.ts` (public factories only):

- `claude: host 2 resumes host 1's saved conversation only after host 1 exited; handles, results, callbacks and wire ids correlate and every leader is gone`, and the same title for `codex:`. Each lifetime is a distinct, actually exited bun process. They share only the retained isolated home and the caller's file store. Host 2's reply holds host 1's unique marker. In each host, every handle, result and onTurnResult names one turnId/messageUuid, and the runtime received exactly those ids: Claude user-frame `uuid`, Codex `turn/start` `clientUserMessageId`. Every receipt leader and every pid the fake recorded is dead (zombie-aware) before host 2 starts and after it exits.
- `claude: a host whose checkpoint store cannot be written still stops its driver in finally, reports the raw failure and exits nonzero, and the parent finds every leader gone`, and the same for `codex:`. The failures must match an exact list of allowed shapes, with the raw ENOENT first in each stop's causes.
- Cleanup (sweep 7553f8ac A9): one shared `ownedAggregate`. Closing is reserved before any spawn, each host's stdout, stderr and exit are joined with allSettled, a failure never skips the remaining hosts, and roots are removed last. The host stops in `finally` on every path after construction.

Existing witnesses, unchanged:

- `claudeResume.test.ts` L02/A1 ×2, A2/I1, R10/A2 and G1/R10 (Claude invalid resume, no fallback).
- `codexRecovery.test.ts` › `two host processes keep one conversation through an awaited kill and an awaited shutdown of the retained home`.
- `codexLifecycle.test.ts`:
  - `L01/R10: a resume answered with another thread fails resume and never adopts or falls back to a fresh thread`
  - `L17/R10: readiness waits for the checkpoint persistence; a send meanwhile is acknowledged only after it`
  - `R10: a rejected persistence fails start with category checkpoint, refuses sends and stops the driver`
  - `L22: a steered message joins the active turn; its handle shares the result whose messageUuid is the opening message`
- `claudeDriverTurns.test.ts` L21 ×2 (queued messages).
- `codexDriver.test.ts` › `L08/L23: a new turn while one is active is refused busy and a queued message unsupported, with nothing sent`.
- The I2 seeded `resume.test.ts` and `codexResume.test.ts`, where acknowledging before persistence or adopting a fresh conversation/thread fails the model.

## U1: controls (killed at 36089de6, restored by sha, src diff empty before and after)

| Control (row) | Mutant | Killed |
|---|---|---|
| M-request Claude (4.3) | `claude/requests.ts` registers the pending entry after event + onRequest | 10/21: `requests.test.ts` Q01/Q02/Q03 inline cases, `inlineRequestsExample.test.ts` › `the example answers each request inside onRequest through the real SDK and the fake CLI` |
| M-request Codex (4.3) | the same in `codex/requests.ts` | 7/29: `codexRequests.test.ts` › `Q01: a question answered from onRequest replies keyed by question id; the request event precedes its resolution` + 6 `Q01: allow on …` |
| M-wire Codex (4.2) | `codex/session.ts` turn/start without `codexTurnStartParams(…, this.permissions)` | `codexDriver.test.ts` › `P07/M-wire: the supplied policy is on thread/start and every turn/start, with the launch cwd` |
| M-wire Kawai Claude (6.1) | `claudeRuntimeLaunch.ts` hands the query a bare SDK option set (no owned spawner/executable) | `createChatDriver.test.ts` › `the claude runtime builds the package-backed Claude adapter without spawning`; `agentRuntimeEquivalence.test.ts` › `0xA609: 128 seeded cases give equal SDK-facing policy facts through Kawai and the package` |
| I1 group cleanup (4.2/2.3) | `ownedProcess.ts` skips group cleanup after the leader exits | 16/60 `I1 after readiness` slices fail; the reach test passes (the cold describe is not a witness for this) |

Raw logs: `/tmp/kbb/ctl/*.log`, summary sha256 671331dfb859c76b…, mutant script fe5b15892bc219cc….

## Rows

- 4.2 checked. Accepted result-adcca8f2 (task e522), with its one unknown resolved above. The M-wire control is fresh, because the e522 control's inputs changed since 9f8f57ab. I1 now covers both the creation-to-start window and booted generations; I2 is `codexResume.test.ts`.
- 4.3 checked. Accepted Claude (ca656ad7) and Codex (e522, result-adcca8f2) request work. Q01-Q04 are in `requests.test.ts`/`codexRequests.test.ts`, and I5 is the `requestRaces.test.ts`/`codexRequestRaces.test.ts` seeded cases. The README block is `inlineRequestsExample.test.ts` › `the README block is exactly examples/inline-requests.ts`. M-request is killed for both runtimes, with no UI or timer.
- 4.4 checked. Accepted Claude (97d6bb7b/8eb64074, dad93cfd) and Codex (e522) resume work, plus U3.
- 2.2 stays unchecked. The Codex I1 gap is closed (both windows), but Claude's exceptional generation teardown is unproved: sweep row 2, backlog task-7cfee843. Claude has no seeded mixed-lifecycle stop sequence. No fresh M-join control was run in this batch.
- 6.1 stays unchecked. The Claude M-wire control is killed. The Codex composition boundary has only the positive witness `createChatDriver.test.ts` › `the codex runtime builds the package-backed Codex adapter without spawning`. With the in-tree Codex driver and client deleted, no in-tree Codex path exists to switch to, so no executed Codex mutant exists, and no whole-6.1 claim is made.
