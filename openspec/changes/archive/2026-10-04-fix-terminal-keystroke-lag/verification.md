# Integration verification record (tasks 8.2 / 8.3 / 8.4)

Date: 2026-10-04. All runs on this workspace (tmux 3.3a, Bun 1.4.2, headless
Chromium via Playwright 1.63). "After" = branch HEAD (26012ab), "before" =
baseline worktree at 6227b7c (pre-change master; both client builds produced
from their own trees, dependencies unchanged between the two).

## Method

Each run boots the server against a private tmux server and isolated state
(`TMUX_TMPDIR`, `TMUX_SESSION`, isolated `AGENTBOARD_DB_PATH` / `LOG_FILE` /
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `PI_HOME`, `LOG_LEVEL=debug`), serving the
production client build (`AGENTBOARD_STATIC_DIR=dist/client`). Workload:
8 flooding windows (deterministic script, byte-identical in before/after runs)
plus one quiet `cat` window for typing. Frames/RTT are measured in the browser
by a version-independent `WebSocket` shim injected before app code, so the
identical instrumentation covers both builds. Keystrokes are real keyboard
events into the focused xterm textarea; RTT = send of `terminal-input` →
receipt of the echoed char in a `terminal-output` frame (the final xterm
render leg is not included).

The `dev-browser` skill named in tasks.md is not installed on this machine;
project-local Playwright (the same library the e2e suite uses) drove the
browser instead. The harness lives outside the repo; workload shapes and
measurement definitions below are sufficient to rebuild it.

## 8.2 Load reproduction results

### terminal-output frame counts over 10 s (identical workloads, attached to one flooding window)

| Workload (per window)          | Build  | Frames/10 s | Bytes/10 s | Avg frame | Inter-frame gap p50 |
| ------------------------------ | ------ | ----------- | ---------- | --------- | ------------------- |
| 24-line burst / 120 ms (~19 KB/s) | before | 173         | 190 784    | 1 103 B   | 25 ms               |
| 24-line burst / 120 ms         | after  | **89**      | 188 042    | 2 113 B   | 121 ms (1/burst)    |
| 96-line burst / 480 ms (~19 KB/s) | before | 91          | 183 842    | 2 020 B   | 0 ms (back-to-back) |
| 96-line burst / 480 ms         | after  | **27**      | 186 970    | 6 925 B   | 481 ms (1/burst)    |

Observed reduction: **1.9x** (line-rate bursts) to **3.4x** (chunky bursts),
at unchanged payload bytes (±1.7% pacing jitter). The 5x figure in tasks.md is
a tuning target, not a correctness assertion; the ceiling at these rates is
set by pty read granularity, which already merges much of each burst before
the coalescer sees it — the coalescer guarantees one frame per event-loop
turn, which is what the 121/481 ms gap p50s show (exactly one frame per
burst).

### Keystroke RTT, 60 s steady typing (520 keys, ~8.7 keys/s) while 8 windows flood

| Build  | Echoed/typed | p50    | p95    | max     | >150 ms | >400 ms |
| ------ | ------------ | ------ | ------ | ------- | ------- | ------- |
| before | 520/520      | 0.3 ms | 0.4 ms | 9.4 ms  | 0       | 0       |
| after  | 520/520      | 1.3 ms | 1.5 ms | 15.8 ms | 0       | 0       |

Transport-only thresholds p95 ≤ 150 ms / max ≤ 400 ms: **met**.
These measurements exclude xterm consumption/rendering and do not certify
keystroke-to-display latency; the rendered-echo follow-up below supplies that check. Note: on
this localhost box the synthetic workload does not reproduce the original
pathological lag (which involved real scrollback depth, log-match bursts and
network RTT); the numbers certify the after-state against the thresholds, not
a before/after latency delta. The after-build pays ~1 ms p50 for coalescing's
extra turn — negligible against the thresholds.

### event-loop lag (LOG_LEVEL=debug monitor, fires >100 ms)

`event_loop_lag` events during the 60 s typing window: **0** (whole-run total
also 0) in the after build, under 8-window flooding. Threshold met.

### Session broadcasts under continuous churn (60 s typing window, 9 active windows)

| Build  | `sessions` broadcasts | Cadence                  | Activity-only mid-bucket broadcasts |
| ------ | --------------------- | ------------------------ | ----------------------------------- |
| before | 30                    | every ~2 000 ms (every refresh) | 28 |
| after  | 2 (runs at 15.6 s / 45.6 s; 3 in the chunky run) | exactly one 30 002 ms bucket interval apart | 0 |

Every after-build broadcast coincided with a 30 s bucket crossing (first
refresh tick 0.6–1.6 s after the boundary); zero broadcasts carried only
sub-quantum activity changes. Emitted `lastActivity` values keep millisecond
precision and advance monotonically (e.g. `...01.549Z` → `...31.550Z`),
confirming precise timestamps survive suppression. All windows churned
continuously here, so they crossed buckets together; per-window bucketing
(different windows crossing at different times) is covered by the registry
unit tests (task 5.3).

## 8.3 Regression sweep results (all PASS, final run; repeated 4+ times)

- **Copy-mode entry**: scroll-up over an attached flooding window shows the
  "Copy mode / Exit" pill in **914–1 170 ms** across runs (750 ms poll +
  attach RTT bound; spec target ~1 s). Server-side `tmux-copy-mode-status`
  replies confirmed `inCopyMode: true`.
- **Copy-mode exit**: typing `q` hides the pill in **4–8 ms**.
- **Session switch replay**: switch to a window with a ~100 KB scrollback —
  history marker present in the replayed `terminal-output` frames, **all
  replay frames precede `terminal-ready`** (D2 ordering held on the wire),
  the card is selected, and no output for any other session id arrives after
  the switch (0 wrong-pane frames). Switch completes in 106–187 ms.
- **Kill animation**: right-click → Kill Session: card still present at
  +80 ms (exit animation in flight, EXIT_DURATION 200 ms), gone from the DOM
  at 257–362 ms in 6/7 runs, tmux window actually killed. Two early runs saw
  the row linger >3 s; extending the wait to 10 s and re-running 5x never
  reproduced (all 257–362 ms). Isolated and full-context repros of the kill
  path measured removal-broadcast latency ~207–225 ms consistently. Treated
  as harness timing flake, not a product defect; noted here for honesty.
- **Rapid A→B→A** (16 switches, 120 ms apart, flooding target): **zero**
  `terminal_output_dropped` client-log posts — the rate limit holds trivially
  because cleanup/backpressure prevented mismatched-output drops entirely in
  this scenario (≤1 per 5 s would have passed).
- **Log matching after edits**: a seeded Claude log (`~/.claude/projects`
  JSONL with a user message) associates the tmux window (`agentSessionId`
  set on the session); after both the pane content changes and the log grows,
  the association persists and `lastUserMessage` advances to the new entry.

## 8.4 Deferred batched-capture follow-up

**Not needed.** 8.2 shows zero `event_loop_lag` events during steady typing
under load and no evidence of refresh contention (broadcast cadence is
bucket-quantized, RTT p95 1.5 ms). The Open Question's precondition ("does
the load test still show refresh-worker contention after the core steps
land?") resolved to no, so the single chained tmux invocation with nonce
separators was not implemented.

## Rendered-echo follow-up (review fixes, 2026-10-04)

The reproducible harness is now checked in at
`scripts/verify-terminal-render-latency.mjs`. Run `bun run build`, then
`bun scripts/verify-terminal-render-latency.mjs` (60 seconds by default).
`VERIFY_SECONDS` adjusts duration; `CHROMIUM_PATH` overrides the browser binary.
It uses a private tmux server, isolated application/log state, eight flooding
windows (24 lines every 120 ms), and one attached quiet `cat` window. All windows
run in a temporary directory, isolating terminal streaming from repository and
OpenSpec discovery. Printable alphanumeric inputs are timestamped at actual
WebSocket send; focus reports such as ESC[I are explicitly excluded. A
nonrepeating expected suffix is matched against xterm's parsed visible buffer
inside `onRender`, and the sample ends on the next animation frame, after a
paint opportunity. This includes buffering, backpressure, parsing, and xterm
rendering; it does not measure physical display scanout. Missing echoes fail
the check, as do p95 >150 ms or max >400 ms.

The full 60-second run recorded **522 / 522 rendered echoes**, p50 **18.8 ms**,
p95 **40.5 ms**, max **49.4 ms**. Both rendered-echo targets passed; zero
`event_loop_lag` events were recorded in the server log. Results,
server logs, and the final browser screenshot were retained at
`/tmp/kawai-render-latency-oGZKfM/` (`results.json`, `agentboard.log`, `terminal.png`).

Scope limitation: exploratory runs using this repository as every window's
working directory showed >1-second server event-loop stalls during synchronous
workspace/OpenSpec discovery. The isolated-directory result verifies the
terminal path under flood load; it does not certify repository discovery under
load or replace that separate workload. The earlier blanket statement of
end-to-end latency success has been narrowed accordingly.

Review fixes also revalidate tmux targets after async matching, hydrate from
current registry metadata, and drain held output before mouse-control writes.
The dedup integration test now sends the second attach directly inside the
first ready callback and scopes capture-count assertions to that connection.
The new real-server copy-mode and coalescing suites run in isolated processes
alongside the existing real-tmux suites, avoiding shared test mocks.

Post-fix validation: `bun run lint && bun run typecheck && bun run test`
completed successfully, including the isolated real-tmux suites. Strict
validation also passed for the terminal-streaming and session-updates specs.
