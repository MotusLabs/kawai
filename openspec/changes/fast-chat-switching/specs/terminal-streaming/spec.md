## RENAMED Requirements

- FROM: `### Requirement: WebSocket compression is opt-in`
- TO: `### Requirement: WebSocket compression applies to large non-terminal messages`

## MODIFIED Requirements

### Requirement: WebSocket compression applies to large non-terminal messages
The server SHALL offer per-message WebSocket compression unless `AGENTBOARD_WS_DEFLATE` is set to `false`. By default it SHALL compress only messages of at least 16 KiB that are not terminal output, and SHALL never compress terminal output. When `AGENTBOARD_WS_DEFLATE` is set to `true` it SHALL compress every message. A client that does not accept compression SHALL receive every message uncompressed.

#### Scenario: Large chat snapshot compressed by default
- **WHEN** the server starts with no `AGENTBOARD_WS_DEFLATE` setting and sends a 500 KiB chat snapshot to a client that accepts compression
- **THEN** the snapshot is sent compressed

#### Scenario: Compression off by default
- **WHEN** the server starts with no `AGENTBOARD_WS_DEFLATE` setting and sends a 64 KiB terminal output frame or a 2 KiB session update
- **THEN** that message is sent uncompressed

#### Scenario: Compression enabled explicitly
- **WHEN** the server starts with `AGENTBOARD_WS_DEFLATE=true`
- **THEN** WebSocket messages are compressed, terminal output included

#### Scenario: Compression disabled explicitly
- **WHEN** the server starts with `AGENTBOARD_WS_DEFLATE=false`
- **THEN** the server offers no compression and every message is sent uncompressed

#### Scenario: Client without compression support
- **WHEN** a client connects without accepting per-message compression
- **THEN** every message to it is sent uncompressed, whatever the setting
