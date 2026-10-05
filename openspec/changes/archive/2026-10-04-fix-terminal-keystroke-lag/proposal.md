# Proposal

## Why

With many parallel tmux windows each containing a lot of text, the web terminal
develops significant keystroke-to-display lag and the UI feels unresponsive.
A keystroke is a full round trip (browser → server → pty → tmux server → pty →
server → browser → xterm render), and today several synchronous tmux subprocess
calls on the server's main event loop, per-frame WebSocket overhead, log-match
capture bursts against the single-threaded tmux server, and a ~2 s client
re-render storm all add directly to that latency. Prior perf work (#118, #143)
fixed adjacent instances of the same failure class; this change removes the
remaining ones.

## What Changes

- Copy-mode checks, copy-mode cancel, and attach-time history capture stop using
  synchronous `Bun.spawnSync` on the main event loop (async spawns via the
  existing `readTmuxCapture` helper), with a per-socket in-flight guard so
  out-of-order copy-mode replies cannot stale-flip state.
- Terminal output frames are coalesced per WebSocket connection (one frame per
  event-loop turn, 512 KiB early-flush cap) through a new
  `TerminalOutputCoalescer`, with a strict ordering contract: every
  non-output message drains the pending output buffer first, so
  history-chunks → `terminal-ready` and output → `terminal-error` ordering is
  preserved. The attach history-chunk loop that bypassed `send()` is routed
  through the coalescer.
- `perMessageDeflate` becomes configurable (`AGENTBOARD_WS_DEFLATE`, opt-in)
  and defaults to off — per-frame deflate CPU sits on the keystroke-echo path
  for escape-sequence-heavy output over LAN/Tailscale.
- The log matcher's 10 000-line scrollback captures are paced: the async
  matcher variant runs windows sequentially with a configurable inter-window
  yield (`AGENTBOARD_LOG_MATCH_YIELD_MS`, default 25 ms), the session-wake path
  on the main thread switches to it, and the match worker serializes requests
  through a promise chain.
- `SessionRegistry.replaceSessions` compares `lastActivity` in 30 s buckets
  while retaining precise timestamps in stored sessions and emitted payloads, so steady output churn no longer re-broadcasts
  the full session list (and re-renders the whole UI) every 2 s.
- Session list rows are memoized with a custom comparator (comparing
  activity buckets and all callback props) plus a `nowTick` prop driven by the
  existing 30 s label timer; the `TerminalControls` input array is stabilized.
- The xterm.js write path applies generation-scoped backpressure (pending-write
  count, 50 ms force-through cap). This bounds flush frequency while parsing
  is busy; it preserves stream order and does not prioritize keystroke echo
  ahead of earlier output. Load measurements must establish the latency benefit.
- `terminal_output_dropped` client-log posts are rate-limited to one per 5 s
  with a suppressed count.
- Rejected by design (documented in design.md): gating refresh captures on
  `#{window_activity}` (whole-second resolution can miss a late-in-second
  permission prompt forever), reducing matcher scrollback depth, and keeping
  deflate on.

## Capabilities

### New Capabilities
- `terminal-streaming`: responsive interactive terminal I/O under parallel
  session load — async server-side tmux interactions on the keystroke path,
  coalesced output frames with strict message ordering, deflate opt-out,
  paced log-match captures, client-side write backpressure, and bounded
  dropped-output diagnostics.
- `session-updates`: change detection and propagation of session state —
  broadcasts fire only on meaningful (quantized) changes, and clients render
  session lists without per-broadcast re-render storms while keeping
  relative-time labels fresh.

### Modified Capabilities

(none — existing specs cover workspace navigation, CI workflows, and OpenSpec
visibility; none describe terminal streaming or session update propagation)

## Impact

- Server: `src/server/index.ts` (copy-mode/history handlers, `send`/`broadcast`
  wiring, history-chunk loop, wake-path matcher call, WS options),
  new `src/server/terminal/outputCoalescer.ts`, `src/server/config.ts`,
  `src/server/logMatcher.ts`, `src/server/logMatchWorker.ts`,
  `src/server/SessionRegistry.ts`.
- Client: `src/client/hooks/useTerminal.ts` (write backpressure, dropped-log
  rate limit), `src/client/components/SessionRow.tsx`, `SessionList.tsx`,
  `WorkspaceSectionList.tsx`, `Terminal.tsx`, `TerminalControls.tsx`.
- Configuration: new env vars `AGENTBOARD_WS_DEFLATE`,
  `AGENTBOARD_LOG_MATCH_YIELD_MS` (README Environment section).
- WebSocket protocol: no message-type changes; only frame granularity of
  `terminal-output` changes (clients already reassemble chunks).
- Behavior change: activity-only broadcasts are suppressed within 30 s buckets;
  payload timestamps retain full precision, but activity-based sorting and
  relative labels may update up to one bucket later; `session-update`
  broadcasts still fire immediately on Enter (force-working UX preserved).
