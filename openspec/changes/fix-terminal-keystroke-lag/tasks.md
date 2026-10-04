# Tasks

## 1. Server: async tmux interactions (design D1)

- [x] 1.1 Convert `handleCheckCopyMode` in `src/server/index.ts` to use
  `await readTmuxCapture(...)` instead of `Bun.spawnSync`, add the
  `copyModeCheckInFlight` field to `WSData` and the upgrade initializer, and
  skip-when-in-flight with `finally` cleanup and discard stale replies using
  attachment-generation/target/socket checks; verify `bun run typecheck` and
  that rapid `tmux-check-copy-mode` messages still produce
  `tmux-copy-mode-status` replies in the integration test from 1.4
- [x] 1.2 Convert `handleCancelCopyMode` to `await readTmuxCapture(...)`;
  verify `bun run typecheck` passes
- [x] 1.3 Make `captureTmuxHistory` async via `readTmuxCapture`, await its
  sole call site in `attachTerminalPersistent`, and confirm the existing
  post-await `isTerminalAttachCurrent` recheck still guards it; verify
  `bun run typecheck`
- [x] 1.4 Add `src/server/__tests__/copy-mode-async.integration.test.ts`
  (real server + tmux, skip when unavailable, following
  `double-attach.integration.test.ts`): status reply arrives;
  `inCopyMode:true` after entering copy-mode server-side; a deliberately delayed probe causes overlapping polls to be skipped;
  the guard clears after success/failure and later polls receive fresh replies;
  a session switch during the probe does not mutate the new attachment; verify the new suite passes with
  `bun test src/server/__tests__/copy-mode-async.integration.test.ts`

- [x] 1.5 Update `src/server/__tests__/isolated/indexHandlers.test.ts` for async
  tmux completion: await emitted status/history-ready messages rather than
  assuming dispatch completion implies handler completion; ensure mocked
  `Bun.spawn` provides readable stdout/stderr, exited Promise, and kill behavior
  expected by `readTmuxCapture`. Restore the currently failing tests
  “session-only attach replays the current grouped view and keeps copy-mode
  targeting aligned in pty mode” and “handles copy-mode commands for active
  session”; run `bun test src/server/__tests__/isolated/indexHandlers.test.ts`

## 2. Server: coalesced terminal-output frames (design D2)

- [x] 2.1 Create `src/server/terminal/outputCoalescer.ts` with
  `TerminalOutputCoalescer` (enqueue with one `setTimeout(0)` flush per turn,
  512 KiB early-flush cap, `sendOrdered` drain-then-send, injected socket-open
  predicate, `dispose`); verify `bun run typecheck`
- [x] 2.2 Wire it into `src/server/index.ts`: `send()` routes
  `terminal-output` through the coalescer and everything else through
  `sendOrdered`; `broadcast()` drains each socket first; the history-chunk
  loop uses `send()` instead of raw `ws.send`; verify the coalescer unit
  tests in 2.4 pass against the module
- [x] 2.3 Dispose the coalescer only on socket close; terminal cleanup clears pending
  data and timers but leaves the open socket reusable. Test detach then attach
  on the same socket, with output delivered for the new attachment
- [x] 2.4 Add `src/server/__tests__/terminalOutputCoalescer.test.ts` (fake
  socket + fake timers): one frame per turn; flush-before-ordered-message
  (terminal-ready after history chunks); early flush at cap; dispose
  semantics; UTF-8 byte accounting and oversize chunks; session-id changes
  drain without requiring a control message; no send after the open predicate fails;
  verify with `bun test src/server/__tests__/terminalOutputCoalescer.test.ts`
- [x] 2.5 Extend `double-attach.integration.test.ts` (or add
  `output-coalescing.integration.test.ts`): drive known ordered markers through a real tmux window and verify
  marker order and final rendered content. Verify exact concatenated stream
  equality against the input chunks in the deterministic coalescer test,
  including ANSI and Unicode; pane captures are not a raw PTY byte oracle; verify the suite passes

## 3. Server: WebSocket compression opt-in (design D3)

- [x] 3.1 Add `wsPerMessageDeflate` to `src/server/config.ts`
  (`AGENTBOARD_WS_DEFLATE`, only literal `true` enables), use it at the
  `websocketHandlers` definition, and document the variable in the README
  Environment section; verify `bun run typecheck`
- [x] 3.2 Extend `src/server/__tests__/config.test.ts`: defaults false,
  `true` → true, junk values → false; verify with
  `bun test src/server/__tests__/config.test.ts`

## 4. Server: paced log-match captures (design D4)

- [x] 4.1 Add `logMatchYieldMs` to `src/server/config.ts`
  (`AGENTBOARD_LOG_MATCH_YIELD_MS`, default 25, clamped 0–250) and document
  it in the README Environment section; verify `bun run typecheck`
- [x] 4.2 Rework `matchWindowsToLogsByExactRgAsync` in
  `src/server/logMatcher.ts` from `Promise.all` to a sequential loop with an
  inter-window yield via an injectable `wait` (new
  `interWindowYieldMs`/`wait` search options); verify the order-equivalence
  and yield tests in 4.4 pass
- [x] 4.3 Switch the session-wake matcher call (`src/server/index.ts`) and
  both match-worker call sites (`src/server/logMatchWorker.ts`) to the paced
  async variant, make the worker handler async, and serialize requests
  through a promise chain in `ctx.onmessage`; verify `bun run typecheck` and
  the serialization test in 4.4; recover the queue after rejection and update
  existing direct handler tests to await its Promise
- [x] 4.4 Extend `src/server/__tests__/logMatcher.test.ts` (async results
  identical to sync on fixtures; yield honored via the injected wait) and
  `src/server/__tests__/logMatchWorker.test.ts` (two queued requests
  serialize, including ordinary/orphan paths, and a failed request does not
  poison the queue); verify with `bun test src/server/__tests__/logMatcher.test.ts
  src/server/__tests__/logMatchWorker.test.ts`

## 5. Server: quantized session broadcasts (design D5)

- [ ] 5.1 Run `rg -n "lastActivity" src/server src/client` and record the audit
  in design.md. Include status sorting, relative labels, remote sessions,
  and Enter updates. Keep precise timestamps; document the accepted bucket
  delay in recency ordering and labels
- [ ] 5.2 Keep precise monotonic `lastActivity` in `nextMap`; compare valid
  timestamps by 30 s bucket only in `replaceSessions` change detection.
  Preserve invalid-timestamp comparison behavior and immediate `updateSession`; verify the
  registry tests in 5.3 pass
- [ ] 5.3 Extend `src/server/__tests__/01-sessionRegistry.test.ts`: no emit
  on sub-quantum churn; emits on status/name/membership change and on bucket
  crossing; stored activity never regresses and retains full precision even without
  an emit; equal-status sessions in the same bucket retain precise recency
  ordering when broadcast; invalid timestamps handled; `createdAt` untouched;
  Enter-path `updateSession` still emits immediately; verify with
  `bun test src/server/__tests__/01-sessionRegistry.test.ts`

## 6. Client: render-storm fixes (design D6)

- [ ] 6.1 Wrap `SortableSessionItem` in `React.memo` with a custom comparator
  (all session fields with activity compared by bucket; all other props
  including callbacks, optional action availability, `nowTick`, drag/drop
  and display flags). Stabilize handler bindings with full dependencies first, and thread a `nowTick` prop from
  `SessionList`'s timestamp tick into both the flat list and
  `WorkspaceSectionList`; verify the row tests in 6.3 pass
- [ ] 6.2 Hoist the `sessions.map(...)` input in `Terminal.tsx` into a
  value-stable memoization of id/name/status (retain identity across new
  arrays with identical strip data), wrap `TerminalControls` in `React.memo` after confirming its
  other props are callback-stable (wrap any that are not in `useCallback`);
  verify the chrome tests in 6.3 pass
- [ ] 6.3 Extend `src/client/__tests__/sessionListComponent.test.tsx` /
  `sessionList.test.ts` (row not re-rendered on same-bucket lastActivity-only change;
  re-rendered on status or activity-bucket change; label refreshes on nowTick;
  replacing a callback invokes the new handler and adding/removing optional
  controls updates the row; duplicate uses current session data; comparator
  exhaustiveness versus the `Session` type) and
  `src/client/__tests__/terminalControls.test.tsx` (stable-input no
  re-render); verify with `bun test src/client/__tests__/sessionListComponent.test.tsx
  src/client/__tests__/sessionList.test.ts src/client/__tests__/terminalControls.test.tsx`

## 7. Client: write backpressure and bounded diagnostics (design D7/D8)

- [ ] 7.1 Add write backpressure to `flush()` in
  `src/client/hooks/useTerminal.ts`: generation-scoped pending-write count and deferred flag,
  non-restarting 50 ms cap, terminal-identity plus generation callback guards,
  and invalidation on session switch/cleanup/terminal-ready. Audit every
  direct write and preserve reset+history atomicity; verify the backpressure tests in 7.3
  pass
- [ ] 7.2 Rate-limit `terminal_output_dropped` clientLog posts to one per 5 s
  with a suppressed count; verify the rate-limit test in 7.3 passes
- [ ] 7.3 Extend `src/client/__tests__/useTerminal.test.tsx` using the
  existing fake-xterm harness: flush defers while a write is pending then
  flushes on callback; forces through after 50 ms despite continuous arrivals; write A callback
  cannot clear pending write B after a forced flush; resets on cleanup;
  old callback on the same terminal after A→B→A cannot flush/reset new data;
  terminal-ready flush stays atomic during an in-flight write; dropped-log
  first report has zero suppressed count, next eligible report carries all
  suppressed events since the previous report; verify with
  `bun test src/client/__tests__/useTerminal.test.tsx`

## 8. Integration verification

- [ ] 8.1 Run `bun run lint && bun run typecheck && bun run test` end-to-end
  and record a fully green run
- [ ] 8.2 Load reproduction per design (8 flooding tmux windows,
  `LOG_LEVEL=debug`): zero `event_loop_lag` events over 100 ms in 60 s of
  steady typing; keystroke RTT via the dev-browser skill p95 ≤ 150 ms /
  max ≤ 400 ms; compare `terminal-output` frame counts over 10 s with identical
  before/after workloads and record observed reduction (5x is a tuning target,
  not a timing-sensitive correctness assertion);
  session-store activity-only updates occur only at bucket crossings (not
  a rolling 30 s throttle; different windows may cross buckets at different times); record the
  before/after numbers in the change log
- [ ] 8.3 Regression sweep via dev-browser: scroll-up enters copy-mode with
  the pill within ~1 s and typing exits it; session switch replays history
  and lands on the right pane; kill still animates; rapid A→B→A switching
  produces no `terminal_output_dropped` burst beyond one per 5 s; log
  matching still associates windows after edits
- [ ] 8.4 Only if 8.2 still shows refresh contention: implement the deferred
  batched-capture follow-up from design's Open Questions (single chained
  tmux invocation, nonce separators, per-window fallback; confirm on tmux
  3.3a that a mid-chain failure does not abort the chain) with
  `sessionRefreshWorker.test.ts` coverage of separator parsing and fallbacks;
  otherwise record that it was not needed
