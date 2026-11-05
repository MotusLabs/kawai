# Tasks

## 1. Probe

- [ ] 1.1 Probe Bun's per-message compression in a scratch script under `/tmp`. The probe is a real `Bun.serve` with `perMessageDeflate: true` and a raw TCP client that negotiates `permessage-deflate`. It records the RSV1 bit of frames sent with `compress` omitted, `true`, and `false`, and of frames sent to a client that did not negotiate. Record the result in the task journal and in `design.md` D3, replacing "Probe 1.1 confirms". In the same probe, with a 1 MiB `backpressureLimit`, a client that stops reading, and `closeOnBackpressureLimit` first `false` and then `true`, record each `ws.send` status, whether the message that crossed the limit is delivered once reading resumes, and whether and when the socket closes. Record these in D5b.
  - Verify: the journal names the Bun version and all four compression observations plus both backpressure runs; D3's and D5b's text match them.

## 2. Window budget (D1)

- [ ] 2.1 Move the client's merge rule into `src/shared/chatTranscriptMerge.ts` as `continuesEntry(prev, next)`, and make `applyChatEvents` import it.
  - Verify: the existing `chatTranscript` merge tests pass unchanged. A W5 row through `historyWindow` fails when the server keeps a private copy of the rule (mutant: the server copy ignores `messageId`).
- [ ] 2.2 Split units into parts at quiet points, and apply the 500-event / 512 KiB encoded-byte budget (UTF-8 length of the delivered events array, envelope excluded; measured on the projection actually returned — the events array after workspaceContext attachment — so the manager prices the same final projection it returns, never a raw-only estimator) in `historyWindow` and its pricing seam for attach, `fromId`, `throughId`, and `beforeId`, as D1 describes: indivisible parts, whole turn units filled newest-first while the complete selected suffix fits both limits, the walk stopping before the first older unit that would overflow the remaining budget once any unit is selected, and only the oversized newest unit with empty selection walking its quiet parts newest-first under the single atomic newest-part exception; the boundary turn's remaining portion before `beforeId`'s part is the page's newest candidate unit.
  - Verify: table W rows W1–W17 are committed verbatim as one table-driven test.
    - W2 kills "budget ignored" and pins whole-unit delivery (480 events of the newest four turns, even with quiet 10-event parts in the fifth).
    - W3 and W14 kill "never split a unit" and "split anywhere" (W3 only with empty selection on the oversized newest unit).
    - W4 and W5 kill "open tool calls ignored" and "merge continuation ignored" (in the part walk, the overflowing part is left whole to older history, never an earlier cut across parts).
    - W8 kills "empty window when oversized".
    - W6 kills "a result priced at its raw size": with elision skipped before pricing, the 600 KiB result overflows and becomes the atomic part.
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

## 6. Connection liveness (D5)

Section 6 may land first, after probe 1.1 and before sections 2–5. Its checkpoint needs nothing from them: elision runs in `getSnapshot` and `getHistoryPage` before today's window, and OW6 uses its section-6 frame bound. The checks that combine D5 with D1 — task 2.2's W6 row, P1's elision clause, and OW6's 600 KiB frame bound — are rerun when section 2 lands, and 7.3 maps them there. No timing claim in this section counts until its test has run.

- [ ] 6.1 Add `elideToolOutput` and `TOOL_OUTPUT_MAX_BYTES` in `src/server/chat/toolOutputElision.ts`, measuring the output's serialized string value (UTF-8 of `JSON.stringify(output)`, quotes included, inclusive limit), with `totalBytes` the canonical UTF-8 length of the whole original output. Add `outputElided` to the `tool_result` event type in `src/shared/chat.ts`, and apply the function in `getSnapshot` and `getHistoryPage` (before D1's pricing once section 2 exists).
  - Verify: table E rows E1–E8 are committed verbatim. E1 and E2 kill an exclusive limit and a limit on decoded bytes, E3 and E4 kill a cut that splits a character, E5 kills elision of other event types, E7 kills a measure that ignores escaping or splits an escape, and E8 kills a `totalBytes` taken from the serialized or preview length. After section 2, task 2.2's W6 row is green only with elision before pricing.
- [ ] 6.2 Apply the same function once at the top of `ChatConnections.publish`, before batching, and cap each `chat-events` message at `CHAT_EVENTS_MAX_BYTES` (262,144 UTF-8 bytes of the whole message as sent) before both send sites, the batch-overflow send and `flush`, keeping the 128-event and turn-boundary splits and sending a lone oversized event by itself (D5e). Leave nested worker transcripts unelided.
  - Verify: rows E6, E9, and E16–E18, and production wiring test OW4. E6 and OW4 kill "live route not elided" on both send sites, E9 kills "search reads the elided projection", E16 kills a batch measured without its envelope or capped on one send site only, and a split that loses, repeats, or reorders events, E17 kills a lone oversized event dropped or merged, and E18 kills a changed turn or 128-event boundary.
- [ ] 6.3 Add `ChatSessionManager.getToolOutput` and the route `GET /api/chat/sessions/:sessionId/tool-output/:eventId` (`src/server/routes/chatToolOutput.ts`, mounted in `bootstrap.ts` beside `/api/chat/search`, before the static fallback), as D5d describes: shared `loadHistory`, lookup again after the await, `404` cases, `text/plain; charset=utf-8`, `no-store`, and `Content-Length` from the bytes served. Check that the service worker does not cache it. Add no WebSocket message for it.
  - Verify: rows E10–E12 through the real app and manager. E10 kills a JSON body, a missing `no-store`, a length not taken from the served bytes, and a body that differs from the canonical UTF-8 of the stored output; E11 kills a `200` with an empty body; E12 kills a lookup that skips replay or writes the projection back.
- [ ] 6.4 Mark elided results in the tool result view. On expand, download the output with one `fetch` and its own `AbortController`, decode it with `TextDecoder('utf-8', { ignoreBOM: true })`, and adopt it only when the whole body has arrived, its length equals `totalBytes`, and the request is still current. Abort on collapse, re-expand, chat switch, detach, and unmount; keep the download across a WebSocket reconnect.
  - Verify: rows E13–E15 as component and store tests over a fake `fetch`. E13 kills a decoder that strips a leading U+FEFF, a partial or short body adopted, and a `404` shown as a network error; E14 kills a late old body overwriting the current view and a state update after unmount; E15 kills a download cancelled or repeated by a WebSocket reconnect or a successful resume.
- [ ] 6.5 Set `closeOnBackpressureLimit: true` and the named `backpressureLimit` constant in `socketHandlers.ts`. Read the `ws.send` status on every `ConnectionHub` and coalescer route, logging `ws_send_dropped` and closing the socket in the hub on `0`. Log `ws_backpressure_close`.
  - Verify: table B rows B1–B5 and production wiring test OW5. B1 kills `closeOnBackpressureLimit` left `false` at the production options boundary; B3, over a fake socket, kills an ignored `0` status on any one route; OW5 kills removing both close mechanisms together (a sequence gap on an open socket).
- [ ] 6.6 In `useWebSocket.ts`, let any inbound message on the current socket, parsed or not, clear a pending heartbeat pong timer and settle a pending resume verification. Leave both deadlines unchanged.
  - Verify: table H rows H1–H8 over the production class with fake timers and a fake socket. H2 and H5 kill "only the matching pong counts", H1 and H6 kill "any timer cleared without an inbound message", H7 kills "noteInbound after parsing", and H8 kills "a replaced socket settles the current socket's timers".
- [ ] 6.7 Add the browser-level regression OW6 (Playwright slow tier, the pacing proxy with its global 50,000 bytes/s budget, 2,500-byte slices every 50 ms round-robin over ready connections and a 1,000 ms injected round trip, `AGENTBOARD_WS_DEFLATE=false`, the pinned fixture, selection time, and resume phase, `bun run build` first).
  - Verify: OW6 passes with its measured-bounds assertions (rate, 100 ms scheduler wait, 1,200 ms verification pong), and reports an oracle gap rather than a product result if the proxy breaks a bound. Its payload assertions are separate from its liveness assertions. It fails with elision disabled on the snapshot route, and with the 5f design (65,536-decoded-byte WebSocket chunks of the U+0001 output, one in flight) under the early resume.

## 7. Close-out

- [ ] 7.1 Update `AGENTS.md`'s chat-history-window bullet with the budget, resume, compression default, release, tool-output elision, and the backpressure and heartbeat rules. Add the `docs/recovery-matrix.md` row for the backpressure close (fault: a connection's outbound buffer fills; mechanism: close and client resync; tests B2 and OW5), as AGENTS.md requires for a new recovery mechanism, and a row for an interrupted full-output download (fault: a network error or short body; mechanism: preview kept with Retry; tests E13 and E14). Add a row for resume's full-snapshot fallback as well, citing R's fallback rows.
- [ ] 7.2 Measure again on the busiest real chat, including the Global Lead chat from the 2026-11-05 incident: bytes on the wire and switch time, cold switch versus resumed switch. Report the numbers beside the proposal's figures.
- [ ] 7.3 Run `bun run check` on the clean committed tree, and map each oracle id (W, R, A, C, L, E, B, H, P, OW) to its test title and killed mutant in the result.
