# Tasks

## 1. Probe

- [ ] 1.1 Probe Bun's per-message compression in a scratch script under `/tmp`. The probe is a real `Bun.serve` with `perMessageDeflate: true` and a raw TCP client that negotiates `permessage-deflate`. It records the RSV1 bit of frames sent with `compress` omitted, `true`, and `false`, and of frames sent to a client that did not negotiate. Record the result in the task journal and in `design.md` D3, replacing "Probe 1.1 confirms".
  - Verify: the journal names the Bun version and all four observations; D3's text matches them.

## 2. Window budget (D1)

- [ ] 2.1 Move the client's merge rule into `src/shared/chatTranscriptMerge.ts` as `continuesEntry(prev, next)`, and make `applyChatEvents` import it.
  - Verify: the existing `chatTranscript` merge tests pass unchanged. A W5 row through `historyWindow` fails when the server keeps a private copy of the rule (mutant: the server copy ignores `messageId`).
- [ ] 2.2 Split units into parts at quiet points, and apply the 500-event / 512 KiB encoded-byte budget (UTF-8 length of the delivered events array, envelope excluded; measured on the projection actually returned — the events array after workspaceContext attachment — so the manager prices the same final projection it returns, never a raw-only estimator) in `historyWindow` and its pricing seam for attach, `fromId`, `throughId`, and `beforeId`, as D1 describes: indivisible parts, whole turn units filled newest-first while the complete selected suffix fits both limits, the walk stopping before the first older unit that would overflow the remaining budget once any unit is selected, and only the oversized newest unit with empty selection walking its quiet parts newest-first under the single atomic newest-part exception; the boundary turn's remaining portion before `beforeId`'s part is the page's newest candidate unit.
  - Verify: table W rows W1–W17 are committed verbatim as one table-driven test.
    - W2 kills "budget ignored" and pins whole-unit delivery (480 events of the newest four turns, even with quiet 10-event parts in the fifth).
    - W3 and W14 kill "never split a unit" and "split anywhere" (W3 only with empty selection on the oversized newest unit).
    - W4 and W5 kill "open tool calls ignored" and "merge continuation ignored" (in the part walk, the overflowing part is left whole to older history, never an earlier cut across parts).
    - W6 and W8 kill "empty window when oversized".
    - W7 kills "exclusive limit".
    - W10 and W11 kill "budget applied to widened windows".
    - W12 and W13 kill "page unbudgeted" and "page may be empty".
    - W15 kills "code-unit length counted as wire bytes".
    - W16 kills "leftover space filled with pieces of an overflowing older unit".
    - W17 kills raw-only measurement: with workspace-context decoration pushing a 510 KiB raw array past the cap, the newest two decorated units are delivered and the third is not.
- [ ] 2.3 Add properties P1 and P3 (seeded LCG, seed `0x5eed`, 500 and 300 cases, no new dependency).
  - Verify: P1 (budgeted modes only; the whole-unit precedence with the empty-selection part branch and its single atomic part; the encoded-byte measure over the complete delivered suffix as actually projected — the workspaceContext decoration included, never a raw-only estimate; unmatched cancelled calls preserved as they stand, never fabricated results) kills the mutant that drops the pending-call check. P3 kills a page that starts at `beforeId`'s part instead of the part before it.

## 3. Resume on reattach (D2)

- [ ] 3.1 Add `held` (newest and start raw ids, the history epoch, and the explicit expanded flag) to `chat-attach`, `historyEpoch` to `chat-snapshot` and `chat-history-page` replies, and `resume` to `chat-snapshot` in `src/shared/`. Mint the epoch at memo population and replace it on retry replacement, release-and-replay, and process restart. Add `resumeDecision` to `historyWindow.ts`, and make `getSnapshot` take `held`.
  - Verify: table R rows R1–R10 are committed verbatim.
    - R2 and R3 kill "missing id treated as index 0" and "missing epoch resumes".
    - R4 kills the missing lower bound.
    - R5 and R6 kill "resume on endpoint presence despite a broken range".
    - R7 kills "empty delta sends full".
    - R9 kills "expanded held ignores `fromId`".
    - R10 (interior rewrite with surviving endpoints) kills "endpoint presence proves the range".
    - The plain reconnect `historyFrom` lower bound (older than the budgeted start) widens without fallback — asserted beside R, never routed through `resumeDecision`.
- [ ] 3.2 Add `rawOrder`, `entryOrigin`, and the held `historyEpoch` to `ChatTranscript`, maintained by `applyChatEvents`, and add the pure `applyResume`. Make `chatStore`'s snapshot handler use `applyResume` when `resume` is present.
  - Verify: table A rows A1–A4 are committed verbatim; a mismatch resolves at whichever site sees it first — server full snapshot (A4) or client discard (A2/A3) — and the tests accept either, demanding neither.
    - A1 kills "`throughSequence` set before the fold" and "trimmed ids kept in `seen`".
    - A2 and A3 kill "mismatch applied anyway".
- [ ] 3.3 Make `chatAttachment.ts` send `held` — newest and start raw ids, the held epoch, and the expanded flag — when it holds a non-empty transcript, and re-attach plain on a discarded resume.
  - Verify: a store test covers the A2/A3 re-attach. It kills the mutant that leaves the transcript stale.
- [ ] 3.4 Add property P2 (seed `0x5eed`, 500 cases).
  - Verify: it kills the mutant that trims by entry id instead of `entryOrigin`, and the mutant that resumes over a replaced memo (an interior rewrite with surviving endpoints must take the full snapshot).
- [ ] 3.5 Add production wiring test OW1 through `ChatConnections` and a real `ChatSessionManager` over a fixture transcript, including a plain reconnect `historyFrom` older than the budgeted window start. OW1 also runs the production budget checks through the real manager: a snapshot and a `getHistoryPage` over the W17 fixture with persisted workspace contexts must return events whose `UTF-8(JSON.stringify(...))` is at most 512 KiB, with the exact selected raw ids, full metadata, and the actual `hasOlder`.
  - Verify: it kills the mutant where the attach handler drops `held` and the one that drops the epoch check (M1); the held/resume controls and the plain reconnect lower bound stay unchanged. The planned counterfactual mutant moves the workspaceContext attachment after raw-only pricing; the response-byte and selection assertions must detect it, not the test setup.
- [ ] 3.6 Add a store test through the real `chatHistoryPages` prepend owner (`src/client/stores/chatHistoryPages.ts`): load a page whose first folded entry spans several raw events, then re-attach with `held` (the resume trims below the new start), then load the next page.
  - Verify: the sequence asserts the page's first raw anchor — not a merged entry id — carried as `historyStartId`/`held.startId`, the page's `rawOrder` and `entryOrigin` installed in the held transcript, `seen` covering the prepended ids, the held `historyEpoch` refreshed from the page reply, and the live `throughSequence` never advanced by a prepend, with no skipped or duplicated page history. It kills the mutant that discards the page's temporary transcript metadata and uses the fresh transcript's first entry id as the start.

## 4. Compression (D3)

- [ ] 4.1 Parse `AGENTBOARD_WS_DEFLATE` into a mode in `config.ts`, and add `compressFor` in `src/server/ws/compression.ts` over the full serialized message's encoded UTF-8 length.
  - Verify: table C rows C1–C10 are committed verbatim.
    - C4 kills "terminal compressed in large mode".
    - C5 and C6 kill an off-by-one threshold; C6 covers the whole small-message class with 16,383/16,384 encoded-byte representatives.
    - C7–C10 kill "only `true` enables".
- [ ] 4.2 Pass `compressFor(...)` explicitly from `ConnectionHub.send`, `ConnectionHub.broadcast`, and the coalescer's ordered and flush sends, carrying the message type and encoded length to the string-only callback; set `perMessageDeflate` from the mode.
  - Verify: production wiring test OW2 captures each physical route's send calls at the production handlers — broadcast, direct send without coalescer, ordered non-terminal, terminal flush. At the native `ServerWebSocket.send(data, compress?)` boundary it requires the actual `compress` parameter — the second argument, zero-based index 1 — to be explicitly present and to equal the required boolean for that route, mode, and input; an absent or `undefined` argument fails even when Bun's default would send identical wire bits (that default stays unknown until probe 1.1). Real-wire negotiation, threshold, and terminal observations are asserted separately and never substitute for the call-boundary assertions. This kills the mutant that omits the flag on any one named route (M1). No test asserts a three-argument `send` or a `publish` signature.
- [ ] 4.3 Update the docs that state compression is opt-in. These are `AGENTS.md`, the README's env variables, and any `docs/` mentions found by `grep -rn AGENTBOARD_WS_DEFLATE`.
  - Verify: the grep shows no "opt-in" wording left.

## 5. Archived memo release (D4)

- [ ] 5.1 Add `noteWatched` calls in `ChatConnections` on attach, detach, and connection close. Add the per-session release timer in `ChatSessionManager` — armed on watched-to-unwatched, on archive while unwatched, and on memo population for an archived unwatched chat (a cancelled attach included) — with the table L re-check, an injectable clock, and the ten-minute eligible-idle deadline. Release only eligible memos: no driver, no load in flight, empty `liveEvents`, no retryable mark; otherwise keep the memo whole.
  - Verify: table L rows L1–L9 are committed verbatim.
    - L2 kills "watched chat released".
    - L3 and L4 kill "driver or load ignored".
    - L6 binds release to the observable eviction effect — memo deleted, the next attach replays equal entries under a fresh `historyEpoch` (OW3) — killing the mutant that skips eviction while reporting success.
    - L7 kills "blind live-event deletion loses live-only entries".
    - L8 kills "retryable memo released".
    - L9 kills "a memo populated by a cancelled attach is never timed".
- [ ] 5.2 Test restore after a release: the restored chat shows its earlier conversation once, followed by new turns. Test that a memo holding live-only entries (the policy notice of an archived stop) is kept and still shown. Test that search over a released chat still finds its text.
  - Verify: the restore test observes release as eviction — the memo is gone and the next attach replays equal entries under a new `historyEpoch` (OW3) — killing the mutant that skips eviction outright. The live-only test kills one that releases anyway. The search test kills one that returns nothing for an unloaded memo.
- [ ] 5.3 Add production wiring test OW3 (fake clock, through `ChatConnections` and the manager), including the cancelled-attach case whose load populates the memo after the client detached.
  - Verify: it kills the mutant where `noteWatched` is never called and the one where population never arms the timer (M1).

## 6. Close-out

- [ ] 6.1 Update `AGENTS.md`'s chat-history-window bullet with the budget, resume, compression default, and release. Add a recovery-matrix row if review judges resume's fallback to be a recovery mechanism.
- [ ] 6.2 Measure again on the busiest real chat: bytes on the wire and switch time, cold switch versus resumed switch. Report the numbers beside the proposal's figures.
- [ ] 6.3 Run `bun run check` on the clean committed tree, and map each oracle id (W, R, A, C, L, P, OW) to its test title and killed mutant in the result.
