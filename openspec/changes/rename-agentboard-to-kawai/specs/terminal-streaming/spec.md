## MODIFIED Requirements

### Requirement: WebSocket compression is opt-in
The server SHALL disable per-message WebSocket compression by default and
SHALL enable it only when `KAWAI_WS_DEFLATE` is set to `true`.

#### Scenario: Compression off by default
- **WHEN** the server starts with no `KAWAI_WS_DEFLATE` setting
- **THEN** WebSocket messages are sent uncompressed

#### Scenario: Compression enabled explicitly
- **WHEN** the server starts with `KAWAI_WS_DEFLATE=true`
- **THEN** WebSocket messages are compressed

### Requirement: Log-match captures yield to interactive traffic
Log matching SHALL capture window scrollbacks sequentially with a configurable
pause between windows (`KAWAI_LOG_MATCH_YIELD_MS`), including the
session-wake path, so match bursts interleave with interactive terminal
traffic instead of monopolizing the tmux server. Match-worker requests SHALL
be serialized within that worker, and a failed request SHALL NOT prevent later
queued requests from running.

#### Scenario: Yield pause configuration
- **WHEN** `KAWAI_LOG_MATCH_YIELD_MS` is unset or set
- **THEN** the pause defaults to 25 and is clamped to 0–250, the session-wake path uses sequential captures, and no global exclusion across worker and wake-path requests is implied

#### Scenario: Match burst paced between windows
- **WHEN** several unmatched windows are matched in one pass
- **THEN** their scrollback captures run one at a time with at least the
  configured pause between consecutive captures

#### Scenario: Wake-path matching uses the paced path
- **WHEN** a hibernating session wakes and triggers matching
- **THEN** its captures follow the same sequential, paced behavior
