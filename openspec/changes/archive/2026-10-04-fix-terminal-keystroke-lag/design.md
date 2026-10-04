# Design

## Context

See proposal.md — Why, for the failure mode. The facts that shape this design:

- Terminal I/O defaults to `TERMINAL_MODE=pty`: one `tmux attach` client per
  WebSocket connection in a Bun pty. Keystrokes are pty writes; output returns
  via the pty data callback and is sent per chunk. The tmux server itself is
  single-threaded and serves every client.
- The codebase already contains the pattern for the fix: `readTmuxCapture`
  (async `Bun.spawn` with kill-timer belt-and-suspenders) exists precisely
  because sync `spawnSync` "would stall terminal streaming", and
  `clipboardPollInFlight` is the established per-socket in-flight-guard
  precedent. An `event_loop_lag` debug monitor already exists for
  verification.
- Prior perf work (#118, #143) fixed adjacent instances: output kept off the
  App-level subscriber chain, chunk-buffered client flushes, payload
  truncation, event-loop yields.
- `index.ts` is a script that starts a server on import — new logic that needs
  unit tests must live in its own module.
- The client polls `tmux-check-copy-mode` every 750 ms per attached terminal;
  the async matcher variant (`matchWindowsToLogsByExactRgAsync`) exists but
  uses `Promise.all`, which would parallelize captures; production uses the
  sync variant in the match worker (sequential) and on the main thread in the
  session-wake path.
- `sessionsEqual` on both server (`SessionRegistry`) and client
  (`sessionStore`) includes `lastActivity`, which advances on any pane-content
  change; relative-time labels have minute granularity
  (`formatRelativeTime`). Status sorting uses precise activity timestamps as
  its tie-breaker (`src/client/utils/sessions.ts`); stable sorting does not
  preserve recency if stored timestamps are rounded.

## Goals / Non-Goals

**Goals:**

- Remove every synchronous tmux subprocess call from the server's main event
  loop on the interactive path.
- Bound per-frame WebSocket overhead (frame count and compression CPU) without
  changing the message protocol or ordering semantics.
- Keep interactive terminal traffic flowing during log-match capture bursts.
- Stop the ~2 s broadcast/re-render storm while preserving immediate
  working-status feedback on Enter.
- Bound client flush frequency during parse backlog and measure its effect
  on typed-key latency without promising priority over earlier output.

**Non-Goals:**

- No WebSocket protocol changes (no new message types; frame granularity of
  `terminal-output` may change, which clients already tolerate).
- No tmux server replacement, no pipe-pane/pty mode changes, no refresh-worker
  activity gating or capture batching (see Open Questions).
- No reduction of matcher scrollback depth or matching recall.
- No general React performance overhaul beyond the session list/terminal
  chrome touched by the re-render storm.

## Decisions

### D1: Async spawns via `readTmuxCapture` + per-socket in-flight guard

Convert `handleCheckCopyMode`, `handleCancelCopyMode`, and
`captureTmuxHistory` to use the existing async helper; callers are already
async/fire-and-forget, and the attach path already re-checks
`isTerminalAttachCurrent` after the (now longer) await window. Add
`copyModeCheckInFlight` to `WSData` (skip-when-in-flight, clear in `finally`)
because a probe that outlasts the 750 ms poll period could otherwise deliver
stale state out of order. Skipping (not queueing) avoids overlapping probes. Capture the attachment
generation and resolved target before awaiting; discard replies if the socket
closed or the attachment/target changed. The in-flight guard alone cannot
prevent a probe for an old attachment from completing after a switch.

*Alternative rejected:* queueing overlapping polls — would deliver bursts of
stale replies; the client only needs the newest state.

### D2: Coalescing in a new `TerminalOutputCoalescer` module with a single ordering rule

`src/server/terminal/outputCoalescer.ts` owns per-socket buffering: chunks
enqueue with one `setTimeout(0)` flush per event-loop turn, early flush at
512 KiB, `sendOrdered(message)` = drain-then-send, `dispose()` on close. The
wire-up in `index.ts` touches exactly three sites: `send()` routes
`terminal-output` through the coalescer and everything else through
`sendOrdered`; `broadcast()` drains each socket before sending; and the raw
history-chunk `ws.send` loop (which bypasses `send()`) is routed through
`send()`. One invariant — *every non-output message drains pending output
first* — preserves chunks-before-`terminal-ready` and output-before-
`terminal-error` ordering. Enforce single-session frames directly: enqueueing
a different session id drains the old buffer before accepting the new chunk;
do not depend on an intervening control message. Count the cap in UTF-8 bytes,
not JavaScript string length. A single oversize chunk may exceed the cap and
must flush immediately. The coalescer lives for the socket lifetime: terminal
cleanup clears its pending buffer/timer without permanently disposing it;
socket close disposes it. Reattachment on the same open socket must still
deliver output.

*Alternatives rejected:* coalescing only in the pty `onData` callback (leaves
the history-chunk bypass and misses the drain rule); microtask flush (runs
before I/O flush — macrotask gives better batching with sub-frame latency).

### D3: `perMessageDeflate` default off, opt-in via env

Terminal output is escape-sequence-heavy; post-D2 frames are fewer and larger
(compression cost and benefit must be measured rather than inferred from size); the app targets LAN/Tailscale where bandwidth is
not binding; and per-frame deflate/inflate CPU sits on the keystroke-echo
path. `AGENTBOARD_WS_DEFLATE=true` restores the old behavior — also the
rollback lever.

### D4: Pace the matcher by sequencing, not parallelism

`matchWindowsToLogsByExactRgAsync` switches from `Promise.all` to a sequential
loop with an inter-window yield (`AGENTBOARD_LOG_MATCH_YIELD_MS`, default 25,
clamp 0–250; injectable wait for tests, mirroring `TerminalProxyBase`'s
`options.wait`). The session-wake main-thread call switches to it; the match
worker handler becomes async and serializes requests through a promise chain
(its handling is documented-sequential). Recover the chain after failures and
await both ordinary and orphan-rematch calls; update direct test callers to
await the now-async handler. Serialization applies within the worker; the
main-thread wake path can overlap it. Post-loop aggregation already
iterates in window order, so results are order-equivalent with the sync
variant — that equivalence gets a regression test.

*Alternative rejected:* adding sleeps inside the sync loop — sync code in a
worker cannot yield, and the wake path needs the async variant anyway.

### D5: Compare activity buckets while retaining precise timestamps

Keep `pickLatestActivity` and precise `lastActivity` in `nextMap`. Change only
session-list change detection to compare `floor(Date.parse(lastActivity) /
30_000)` for valid timestamps; invalid timestamps retain the existing raw-value
comparison behavior. Replace the stored map even when no event is emitted, as
the current implementation does. Compare all other fields as before. Do not
quantize `updateSession` or its immediate Enter-path event.

Audit both server and client consumers. The existing status sort uses precise
activity as a tie-breaker, so rounding registry data is rejected. Suppressing
activity-only broadcasts still delays recency updates until bucket crossing;
this bounded delay is accepted, while payloads retain precise ordering between
sessions when they are delivered. Relative labels near minute boundaries can
also change later; do not claim that minute-granularity display is lossless.

### D6: Custom-comparator memoization, `nowTick` prop, stable chrome inputs

Stabilize row callbacks before memoizing: prefer a memoized wrapper receiving
stable parent handlers and a session id, with row-local `useCallback` bindings.
Audit `App.handleDuplicateSession`, which closes over `sessions`, and
`SessionList.handleRename`, which is currently recreated on each render.
Compare every callback prop, including optional callback availability. Never
ignore function props: a stable row must call the latest handler after its
parent dependencies change. Compare all other props, and session fields with
activity compared by bucket. Thread `nowTick` from the 30 s timer through both
list variants so labels use the current precise timestamp on each tick.
Retain drag/drop, editing, control permissions, and reduced-motion behavior.

For terminal chrome, memoize the derived id/name/status array by its actual
values, or retain its previous reference when a new sessions array has identical
strip data. `useMemo([sessions])` alone is insufficient for activity-only
broadcasts. Compare callback props and stabilize them with complete dependencies.

### D7: Generation-scoped pending-write count with a force-through cap

Track a pending-write count and generation token for each attachment lifecycle.
Increment immediately before each `terminal.write`; callbacks decrement only
when both terminal identity and generation still match. A boolean is unsafe:
the cap can issue write B before callback A, and callback A must not mark B as
consumed. Hold buffered data while the count is positive. Arm a single cap
from the first deferred flush; new chunks must not restart it. At 50 ms flush
once even if writes remain pending, then arm a new cap only if more data is
subsequently deferred. Flush immediately after callbacks reduce the count to
zero. Preserve byte order; this mechanism cannot move key echo ahead of output.

On session switch or cleanup, invalidate callbacks, clear timers and deferred
state, and reset the count. `terminal-ready` bypasses deferral for the existing
atomic reset+history write; advance the generation before that forced write so
old callbacks on the reused terminal cannot change its new accounting. Audit
other direct writes (cached content and mouse-mode sequences) and either include
them in accounting or explicitly establish an isolated lifecycle boundary.

### D8: Rate-limit dropped-output diagnostics

Module-scoped monotonic last-emitted timestamp + suppressed counter; one
`clientLog('terminal_output_dropped', …)` per 5 s with the count since the previous emitted report folded into the next report.
The first report has count zero; later suppressed events cannot be retroactively
added to it. No trailing report is required when the burst ends.
Level stays `info` — it is the diagnostic for a real bug class (missing
history after kill); only the burst cost is removed.

## Risks / Trade-offs

- [Coalescing reorders messages and breaks client state machines] → Single
  drain rule at every send site including the history-chunk bypass; unit
  tests assert both ordering pairs and single-session frames; deterministic test asserts concatenated input/output equality; real tmux
  integration checks ordered markers and final rendered content.
- [Async cancel-copy-mode lets input race the cancel] → Pre-existing
  on the remote path; documented in the spec as accepted behavior.
- [Worker handler becomes async → concurrent-request races] → Promise-chain
  serialization with a queued-request test.
- [Quantization hides a consumer needing sub-30 s precision] → Audit
  both client and server; retain precise stored/payload values; grace-period math lives
  in ms-epoch worker state and is untouched.
- [Backpressure stalls on a never-firing write callback] → 50 ms force-through
  cap degenerates to current stacking behavior.
- [Deflate-off increases bandwidth on slow links] → Env opt-in restores it;
  history replay (~100 KB) still fits a couple of slow-start windows.
- [Comparator drift as `Session` grows] → Comparator accounts for every prop and session field, with
  activity compared by bucket; a type-level exhaustiveness
  check in tests fails when a field is added without updating it.

## Migration Plan

Ship as a single release on the normal branch/PR flow. `AGENTBOARD_WS_DEFLATE`
and `AGENTBOARD_LOG_MATCH_YIELD_MS` are the operational dials (rollback for
compression; contention tuning for matching). No data migration; no protocol
change. Verification per tasks.md: lint/typecheck/test after each task, plus
the load reproduction with the existing `event_loop_lag` monitor, keystroke
RTT measurement, frame-count reduction, and re-render counts.

## Open Questions

- Does the load test still show refresh-worker contention after the core
  steps land? If yes, implement the deferred batched-capture follow-up
  (single chained tmux invocation with nonce separators and per-window
  fallback — requires confirming on tmux 3.3a that a mid-chain failure does
  not abort the chain). Deferrable: it changes no spec behavior.

## `lastActivity` audit (task 5.1, 2026-10-04)

`rg -n "lastActivity" src/server src/client"` — every consumer, and what D5's
bucketed change detection does to it:

- **Status sorting** (`src/client/utils/sessions.ts:54-60`): status priority
  first, precise `Date.parse(lastActivity)` descending as the tie-breaker.
  Reads the *emitted payload* timestamps, which stay precise — sorting is
  unaffected; only the moment a newer activity becomes *visible* can lag up to
  one bucket. Accepted per D5.
- **Grace-period staleness math** (`src/client/utils/sessions.ts:80-127`,
  ms-epoch comparisons on `lastActivity`/`lastActivityAt` for dormant/working
  grace windows): operates on precise payload values; untouched.
- **Relative-time labels** (`SessionRow.tsx:227`,
  `HistorySessionItem.tsx:29`, `HibernatingSessionItem.tsx:39`,
  `SessionPreviewModal.tsx:51`, `Terminal.tsx:175` via `formatRelativeTime`):
  minute-granularity display. Labels can change up to one bucket late after a
  suppression; the 30s `nowTick` (D6) keeps them fresh thereafter. Minute
  boundaries may shift one bucket late — not claimed lossless.
- **Client store dedup** (`src/client/stores/sessionStore.ts:18`):
  `sessionsEqualById` includes raw `lastActivity` equality. With bucketed
  server broadcasts, sub-quantum churn no longer *arrives* at the store at
  all, so this comparison no longer triggers per-refresh re-renders; on
  bucket crossings the change is real and the store updates. Left as-is
  (precise values, only compared when a broadcast lands).
- **Server producers**: `SessionManager.ts:754` /
  `sessionRefreshWorker.ts:367` (tmux `last_changed`), `logPoller.ts`
  (log timestamps / mtimes, several sites), `remoteSessions.ts:435`
  (`toIsoFromSeconds` from remote activity flags), `index.ts:2902` (Enter →
  `new Date(now)`, the force-working path via `updateSession`, not quantized),
  `index.ts:1090`/`3699` and `agentSessions.ts:14` (DB `lastActivityAt`
  pass-through). All keep producing precise timestamps; only
  `SessionRegistry.replaceSessions` change detection quantizes.
- **Registry monotonicity** (`SessionRegistry.pickLatestActivity`): keeps the
  precise max of existing/incoming per id; the stored map is replaced even
  when no event is emitted, so the precise latest value survives suppression
  and ships in the next emitted payload.
- **DB (`db.ts`)**: `last_activity_at` persistence of precise values;
  untouched by D5.
- **Enter updates** (`index.ts:2902` + `updateSession`):
  `updateSession` emits `session-update` immediately — outside the
  quantization cadence — so the force-working UX on Enter is preserved.

**Accepted delay:** activity-only recency ordering and label changes may
become visible up to one 30s bucket late; payloads and stored values never
lose precision, and invalid timestamps keep raw-comparison behavior in change
detection.

## Review baseline (2026-10-04)

The working tree already contains partial D1 implementation in
`src/server/index.ts`; unchecked tasks are not proof that no code exists.
Verify those edits against the revised requirements before completing tasks.
Strict OpenSpec validation, lint, and typecheck passed during this planning
review. The full test command exited with two failures in the isolated handler
suite: grouped-view history replay and active-session copy-mode commands.
The harness delegates async spawn to its synchronous result mock; inspect both
subprocess interfaces and assertions that may run before async sends complete.
Task 1.5 explicitly covers restoring these tests. No implementation files were
changed by this review.
