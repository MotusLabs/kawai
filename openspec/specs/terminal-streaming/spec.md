# terminal-streaming Specification

## Purpose

Keeps the interactive web terminal responsive under parallel tmux session load:
keystroke echo, output streaming, and copy-mode interactions must not stall
behind background tmux work, per-frame overhead, or client render backlogs.

## Requirements

### Requirement: Terminal requests never block on tmux bookkeeping
The server SHALL handle copy-mode status queries, copy-mode cancellation, and
attach-time history capture without blocking terminal input dispatch or
terminal output delivery. A copy-mode status query that is still in flight
SHALL cause subsequent status polls on the same connection to be skipped until
it completes.

#### Scenario: Stale status responses are discarded
- **WHEN** a copy-mode status query completes after its attachment generation or target changed while it was pending, or after the socket has closed
- **THEN** the response is discarded, so replies cannot arrive out of order and stale-flip state

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
notifications. A frame SHALL carry output for at most one session.

#### Scenario: Session-id change and terminal cleanup
- **WHEN** a connection's session-id changes, or terminal cleanup runs while output is pending
- **THEN** a session-id change drains the old buffer even without an intervening control message, cleanup clears pending output without disabling later attaches on the same open socket, and socket close disposes the coalescer

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
pause between windows (`AGENTBOARD_LOG_MATCH_YIELD_MS`), including the
session-wake path, so match bursts interleave with interactive terminal
traffic instead of monopolizing the tmux server. Match-worker requests SHALL
be serialized within that worker, and a failed request SHALL NOT prevent later
queued requests from running.

#### Scenario: Yield pause configuration
- **WHEN** `AGENTBOARD_LOG_MATCH_YIELD_MS` is unset or set
- **THEN** the pause defaults to 25 and is clamped to 0–250, the session-wake path uses sequential captures, and no global exclusion across worker and wake-path requests is implied

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
bounded interval so the pipeline always progresses. Deferral SHALL NOT
apply across session switches, and backpressure state SHALL reset when the
terminal is cleaned up or a session becomes ready. This requirement preserves
stream order and does not prioritize key echo ahead of previously received
output.

#### Scenario: Forced flushes and write accounting
- **WHEN** the flush interval elapses, a terminal write's callback completes, a callback from an earlier attachment generation arrives on a reused terminal object, or the terminal becomes ready
- **THEN** the forced interval is 50 ms, each forced write remains pending until its own callback completes, earlier-generation callbacks do not affect current write accounting, and terminal-ready forces the existing atomic reset+history flush

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

### Requirement: Log discovery excludes chat transcripts before reading their content
Before any token or last-message read, the match worker SHALL check identities in order: the file-name thread id and the stored record or session id without opening the file, then the head session id from the bounded identity parse. The first excluded hit SHALL drop the log; being known never skips a stage. This SHALL hold for new, known, orphan, and backfill candidates in both collectors and the final list, after the newest-`maxLogs` selection.

#### Scenario: Rollout excluded by file name
- **WHEN** a poll selects a rollout whose file-name thread id belongs to a chat session
- **THEN** the file is never opened and is absent from the entries

#### Scenario: Chat record excluded without a read
- **WHEN** a known session's id, or an orphan or backfill record's session id, belongs to a chat session
- **THEN** the file is never opened, and it is absent from entries, orphan matches, and last-message results

#### Scenario: Excluded head id on any candidate
- **WHEN** a new, known, orphan, or backfill candidate's file-name and stored ids are not excluded, but its head session id belongs to a chat session
- **THEN** only the head identity parse reads it, no token or last-message read runs, and it is absent from entries, matches, and final attachment

#### Scenario: Unresolved head identity
- **WHEN** no excluded id is found and the bounded head yields no session id
- **THEN** no exclusion is inferred, no identity is fabricated, and the log keeps its existing eligibility and stored metadata

#### Scenario: Unexcluded logs unchanged
- **WHEN** a log's identity matches no excluded id, or no exclude set is given
- **THEN** it is enriched, gated, and matched as before

### Requirement: Token enrichment reads bounded windows
Token enrichment SHALL read at most a 200 KiB head window and a 200 KiB tail window of a log through one file descriptor, plus one lookbehind byte before the tail, and SHALL use no whole-file read. Only complete lines count. The tail SHALL keep its first line when it starts at a line start. Head identity parsing (up to 1 MiB) and exact matching are unchanged.

#### Scenario: Large log read in windows
- **WHEN** enrichment reads an unknown 700 MiB log
- **THEN** it reads at most 409,601 bytes of that file for the token evidence

#### Scenario: Size independence
- **WHEN** a 1 MiB log and a 1 GiB log share the same head and tail windows
- **THEN** both reads return the same number of bytes and the same evidence

#### Scenario: Tail starting at a line boundary
- **WHEN** the tail window starts exactly at the start of a line that holds message text
- **THEN** that line counts

### Requirement: Token evidence distinguishes complete from partial observations
Enrichment SHALL report known, unavailable, complete with an exact count, or partial with a lower bound. Complete SHALL require matching generations before and after the read, every requested byte read, the whole file covered, and every record accounted for without a partial line, early exit, or count limit. Any failed condition SHALL yield partial, even after an observed positive. A missing or unreadable log SHALL be unavailable.

#### Scenario: Small log read completely
- **WHEN** a stable log within 200 KiB is read fully and every record parses
- **THEN** its evidence is complete with the exact count, zero included

#### Scenario: Message only outside the windows
- **WHEN** a large log's only message text lies between the head and tail windows
- **THEN** its evidence is partial with count 0

#### Scenario: Positive then change
- **WHEN** message text is observed and the file then changes between the two stats, or a read returns fewer bytes than requested
- **THEN** the evidence is partial, never complete

#### Scenario: Missing log
- **WHEN** the log cannot be opened or read
- **THEN** the evidence is unavailable and it is not inserted this poll

### Requirement: Token gates and empty caches act only on complete evidence
Token gates SHALL reject only complete evidence below a positive minimum: a complete zero as empty, a complete positive as below threshold. A minimum of 0 or less SHALL pass all complete evidence; partial evidence SHALL stay eligible. Both empty caches SHALL admit only a stable complete zero, never a threshold rejection or a log with no session id, and SHALL reuse it only under the same file generation, mode, and options.

#### Scenario: Partial evidence stays eligible
- **WHEN** a log's evidence is partial with any count and the minimum is 1 or 2
- **THEN** no token gate rejects it and neither empty cache holds it; existing matching and insertion eligibility is preserved, and window binding follows the unchanged matcher

#### Scenario: Giant line before a short message
- **WHEN** an otherwise eligible log holds a valid line over 16 MiB with no message text, then a short user message, then a 300 KiB line with no message text
- **THEN** it reaches the unchanged matching and insertion paths without token rejection or an empty-cache entry; the literal form inserts with no bound window, and a short trailing line binds the expected window

#### Scenario: Complete zero
- **WHEN** a log's evidence is complete with count 0
- **THEN** it is rejected as empty at minimum 1, cached as empty, and the cached zero passes the token gate at minimum 0

#### Scenario: Complete positive below a generic minimum
- **WHEN** a log's evidence is complete with count 1 and the minimum is 2
- **THEN** it is rejected below threshold, neither empty cache holds it, and the same unchanged log passes at minimum 1

#### Scenario: No session id yet
- **WHEN** the poller meets a log with no session id
- **THEN** it writes no empty-cache entry, and the log is reconsidered once its id appears

#### Scenario: Same-size rewrite
- **WHEN** a log cached as a complete zero is rewritten at the same size with its mtime restored, or replaced at the same path
- **THEN** the cache entry is not reused and the log is read again
