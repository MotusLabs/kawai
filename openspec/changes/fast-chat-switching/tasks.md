# Tasks

## 1. Probe

- [ ] 1.1 Probe Bun's per-message compression in a scratch script under `/tmp`. The probe is a real `Bun.serve` with `perMessageDeflate: true` and a raw TCP client that negotiates `permessage-deflate`. It records the RSV1 bit of frames sent with `compress` omitted, `true`, and `false`, and of frames sent to a client that did not negotiate. Record the result in the task journal and in `design.md` D3, replacing "Probe 1.1 confirms".
  - Verify: the journal names the Bun version and all four observations; D3's text matches them.

## 2. Window budget (D1)

- [ ] 2.1 Move the client's merge rule into `src/shared/chatTranscriptMerge.ts` as `continuesEntry(prev, next)`, and make `applyChatEvents` import it.
  - Verify: the existing `chatTranscript` merge tests pass unchanged. A W5 row through `historyWindow` fails when the server keeps a private copy of the rule (mutant: the server copy ignores `messageId`).
- [ ] 2.2 Split units into parts at quiet points, and apply the 500-event / 512 KiB budget in `historyWindow` for attach, `fromId`, `throughId`, and `beforeId`, as D1 describes.
  - Verify: table W rows W1–W14 are committed verbatim as one table-driven test.
    - W2 kills "budget ignored".
    - W3 and W14 kill "never split a unit" and "split anywhere".
    - W4 kills "open tool calls ignored".
    - W5 kills "merge continuation ignored".
    - W6 and W8 kill "empty window when oversized".
    - W7 kills "exclusive limit".
    - W10 and W11 kill "budget applied to widened windows".
    - W12 and W13 kill "page unbudgeted" and "page may be empty".
- [ ] 2.3 Add properties P1 and P3 (seeded LCG, seed `0x5eed`, 500 and 300 cases, no new dependency).
  - Verify: P1 kills the mutant that drops the pending-call check. P3 kills a page that starts at `beforeId`'s part instead of the part before it.

## 3. Resume on reattach (D2)

- [ ] 3.1 Add `held` to `chat-attach` and `resume` to `chat-snapshot` in `src/shared/`. Add `resumeDecision` to `historyWindow.ts`, and make `getSnapshot` take `held`.
  - Verify: table R rows R1–R8 are committed verbatim.
    - R2 and R3 kill "missing id treated as index 0".
    - R4 kills the missing lower bound.
    - R5 kills the missing upper bound.
    - R7 kills "empty delta sends full".
    - R8 kills "expanded held ignores `fromId`".
- [ ] 3.2 Add `rawOrder` and `entryOrigin` to `ChatTranscript`, maintained by `applyChatEvents`, and add the pure `applyResume`. Make `chatStore`'s snapshot handler use `applyResume` when `resume` is present.
  - Verify: table A rows A1–A4 are committed verbatim.
    - A1 kills "`throughSequence` set before the fold" and "trimmed ids kept in `seen`".
    - A2 and A3 kill "mismatch applied anyway".
- [ ] 3.3 Make `chatAttachment.ts` send `held` when it holds a non-empty transcript, and re-attach plain on a discarded resume.
  - Verify: a store test covers the A2/A3 re-attach. It kills the mutant that leaves the transcript stale.
- [ ] 3.4 Add property P2 (seed `0x5eed`, 500 cases).
  - Verify: it kills the mutant that trims by entry id instead of `entryOrigin`.
- [ ] 3.5 Add production wiring test OW1 through `ChatConnections` and a real `ChatSessionManager` over a fixture transcript.
  - Verify: it kills the mutant where the attach handler drops `held` (M1).

## 4. Compression (D3)

- [ ] 4.1 Parse `AGENTBOARD_WS_DEFLATE` into a mode in `config.ts`, and add `compressFor` in `src/server/ws/compression.ts`.
  - Verify: table C rows C1–C10 are committed verbatim.
    - C4 kills "terminal compressed in large mode".
    - C5 and C6 kill an off-by-one threshold.
    - C7–C10 kill "only `true` enables".
- [ ] 4.2 Pass `compressFor(...)` explicitly from `ConnectionHub.send`, `ConnectionHub.broadcast`, and the coalescer's send. Set `perMessageDeflate` from the mode.
  - Verify: production wiring test OW2 uses a raw TCP client against the production handlers. It kills the mutant that omits the flag on any one path (M1).
- [ ] 4.3 Update the docs that state compression is opt-in. These are `AGENTS.md`, the README's env variables, and any `docs/` mentions found by `grep -rn AGENTBOARD_WS_DEFLATE`.
  - Verify: the grep shows no "opt-in" wording left.

## 5. Archived memo release (D4)

- [ ] 5.1 Add `noteWatched` calls in `ChatConnections` on attach, detach, and connection close. Add the per-session release timer in `ChatSessionManager`, with the table L re-check and an injectable clock.
  - Verify: table L rows L1–L6 are committed verbatim.
    - L2 kills "watched chat released".
    - L3 and L4 kill "driver or load ignored".
    - L6 kills "live events kept after release", which would duplicate on reopen.
- [ ] 5.2 Test restore after a release: the restored chat shows its earlier conversation once, followed by new turns. Test that search over a released chat still finds its text.
  - Verify: the restore test kills the mutant that keeps `liveEvents`. The search test kills one that returns nothing for an unloaded memo.
- [ ] 5.3 Add production wiring test OW3 (fake clock, through `ChatConnections` and the manager).
  - Verify: it kills the mutant where `noteWatched` is never called (M1).

## 6. Close-out

- [ ] 6.1 Update `AGENTS.md`'s chat-history-window bullet with the budget, resume, compression default, and release. Add a recovery-matrix row if review judges resume's fallback to be a recovery mechanism.
- [ ] 6.2 Measure again on the busiest real chat: bytes on the wire and switch time, cold switch versus resumed switch. Report the numbers beside the proposal's figures.
- [ ] 6.3 Run `bun run check` on the clean committed tree, and map each oracle id (W, R, A, C, L, P, OW) to its test title and killed mutant in the result.
