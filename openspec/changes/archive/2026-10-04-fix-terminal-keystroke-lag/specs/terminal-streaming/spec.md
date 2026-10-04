# Spec Delta

## Purpose

Keeps the interactive web terminal responsive under parallel tmux session load:
keystroke echo, output streaming, and copy-mode interactions must not stall
behind background tmux work, per-frame overhead, or client render backlogs.

## ADDED Requirements

### Requirement: Terminal requests never block on tmux bookkeeping
The server SHALL handle copy-mode status queries, copy-mode cancellation, and
attach-time history capture without blocking terminal input dispatch or
terminal output delivery. A copy-mode status query that is still in flight
SHALL cause subsequent status polls on the same connection to be skipped until
it completes, so replies cannot arrive out of order and stale-flip state.
A response SHALL be discarded when its attachment generation or target has
changed while the query was pending, or when the socket has closed.

#### Scenario: Keystrokes forwarded while a status query is in flight
- **WHEN** a copy-mode status query is in flight and the user types
- **THEN** the keystrokes are forwarded to the terminal without waiting for the
  query to complete

#### Scenario: Overlapping status polls are skipped, not queued
- **WHEN** a status query takes longer than the client's poll interval
- **THEN** polls arriving during it are skipped and the next completed query
  reports current state

#### Scenario: Cancel no longer guarantees ordering versus keystrokes
- **WHEN** a copy-mode cancel races a keystroke
- **THEN** either may reach tmux first; keystrokes arriving before cancellation
  completes may be consumed by copy-mode navigation, with no one-key bound

### Requirement: Terminal output frames are coalesced per connection
The server SHALL combine terminal-output chunks destined for one WebSocket
connection that arrive within the same event-loop turn into a single message,
and SHALL flush the combined frame early when buffered output reaches a
512 KiB UTF-8 byte cap. A single oversize chunk SHALL flush immediately. Concatenated frame data SHALL be identical to the un-coalesced
stream.

#### Scenario: Burst becomes one frame
- **WHEN** multiple output chunks for one session arrive in one event-loop turn
- **THEN** the client receives a single terminal-output message whose data is
  the concatenation of the chunks

#### Scenario: Oversize buffer flushes early
- **WHEN** buffered output exceeds the byte cap before the turn ends
- **THEN** a frame is sent immediately and buffering resumes for the remainder

### Requirement: Output ordering is preserved across message types
The server SHALL send all pending coalesced terminal output before any other
message on the same connection, including attach history chunks relative to
the terminal-ready acknowledgement and live output relative to terminal-error
notifications. A frame SHALL carry output for at most one session. A session-id change
SHALL drain the old buffer even without an intervening control message.
Terminal cleanup SHALL clear pending output without disabling later attaches
on the same open socket; socket close SHALL dispose the coalescer.

#### Scenario: History chunks precede terminal-ready
- **WHEN** a session attach replays history and then acknowledges readiness
- **THEN** every history frame is delivered before the terminal-ready message

#### Scenario: Output precedes terminal-error
- **WHEN** output is pending when a terminal error is raised
- **THEN** the pending output frame is sent before the error message

### Requirement: WebSocket compression is opt-in
The server SHALL disable per-message WebSocket compression by default and
SHALL enable it only when `AGENTBOARD_WS_DEFLATE` is set to `true`.

#### Scenario: Compression off by default
- **WHEN** the server starts with no `AGENTBOARD_WS_DEFLATE` setting
- **THEN** WebSocket messages are sent uncompressed

#### Scenario: Compression enabled explicitly
- **WHEN** the server starts with `AGENTBOARD_WS_DEFLATE=true`
- **THEN** WebSocket messages are compressed

### Requirement: Log-match captures yield to interactive traffic
Log matching SHALL capture window scrollbacks sequentially with a configurable
pause between windows (`AGENTBOARD_LOG_MATCH_YIELD_MS`, default 25, clamped to
0–250), including the session-wake path, so match bursts interleave with
interactive terminal traffic instead of monopolizing the tmux server.
Match-worker requests SHALL be serialized within that worker, and a failed
request SHALL NOT prevent later queued requests from running. The session-wake
path SHALL use sequential captures; no global exclusion across worker and
wake-path requests is implied.

#### Scenario: Match burst paced between windows
- **WHEN** several unmatched windows are matched in one pass
- **THEN** their scrollback captures run one at a time with at least the
  configured pause between consecutive captures

#### Scenario: Wake-path matching uses the paced path
- **WHEN** a hibernating session wakes and triggers matching
- **THEN** its captures follow the same sequential, paced behavior

### Requirement: Client defers flushes behind unconsumed writes
The web terminal SHALL hold newly buffered output while a previous terminal
write has not been consumed by the renderer, and SHALL force a flush after a
bounded interval (50 ms) so the pipeline always progresses. Deferral SHALL NOT
apply across session switches, and backpressure state SHALL reset when the
terminal is cleaned up or a session becomes ready. Each forced write SHALL
remain pending until its own callback completes. Callbacks from earlier
attachment generations SHALL NOT affect current write accounting, even when
the terminal object is reused. Terminal-ready SHALL force the existing atomic
reset+history flush. This requirement preserves stream order and does not
prioritize key echo ahead of previously received output.

#### Scenario: Flush waits for the renderer
- **WHEN** output arrives while a prior write is still being parsed
- **THEN** the new output is held until the prior write completes, then written

#### Scenario: Stalled renderer cannot stall the pipeline
- **WHEN** a write's completion never arrives
- **THEN** the next flush is forced within 50 ms

#### Scenario: Forced overlapping writes remain accounted for
- **WHEN** write B is forced while write A is pending, then A completes
- **THEN** B remains pending and ordinary flushes continue to defer

#### Scenario: Old callback after a session switch
- **WHEN** a previous attachment's callback fires on the reused terminal
- **THEN** it does not decrement the current pending count or flush new data

### Requirement: Dropped-output diagnostics are rate-limited
The client SHALL report mismatched-session terminal output at most once per
5 seconds, including the count suppressed since the previous emitted report in the
next eligible report. The first report SHALL have a suppressed count of zero;
no trailing report is required if no further dropped output arrives.

#### Scenario: Burst during rapid switching logs once
- **WHEN** many mismatched output messages arrive within 5 seconds
- **THEN** at most one diagnostic is submitted; subsequent events are counted
  for the next report, if a dropped message arrives at least 5 seconds later
