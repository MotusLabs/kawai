## RENAMED Requirements

- FROM: `### Requirement: WebSocket compression is opt-in`
- TO: `### Requirement: WebSocket compression applies to large non-terminal messages`

## MODIFIED Requirements

### Requirement: WebSocket compression applies to large non-terminal messages
The server SHALL offer per-message WebSocket compression unless `AGENTBOARD_WS_DEFLATE` is set to `false`. By default it SHALL compress only messages whose full serialized outbound form is at least 16,384 encoded UTF-8 bytes and that are not terminal output, and SHALL never compress terminal output. When `AGENTBOARD_WS_DEFLATE` is set to `true` it SHALL compress every message. A client that does not accept compression SHALL receive every message uncompressed.

#### Scenario: Large chat snapshot compressed by default
- **WHEN** the server starts with no `AGENTBOARD_WS_DEFLATE` setting and sends a 500 KiB chat snapshot to a client that accepts compression
- **THEN** the snapshot is sent compressed

#### Scenario: Compression off by default
- **WHEN** the server starts with no `AGENTBOARD_WS_DEFLATE` setting and sends a 64 KiB terminal output frame or a 2 KiB session update
- **THEN** that message is sent uncompressed

#### Scenario: The threshold is decided in encoded bytes
- **WHEN** the server in default mode sends a non-terminal message whose encoded UTF-8 size is 16,383 bytes and one whose encoded size is 16,384 bytes to a client that accepts compression
- **THEN** the 16,383-byte message is sent uncompressed and the 16,384-byte message is sent compressed

#### Scenario: Compression enabled explicitly
- **WHEN** the server starts with `AGENTBOARD_WS_DEFLATE=true`
- **THEN** WebSocket messages are compressed, terminal output included

#### Scenario: Compression disabled explicitly
- **WHEN** the server starts with `AGENTBOARD_WS_DEFLATE=false`
- **THEN** the server offers no compression and every message is sent uncompressed

#### Scenario: Client without compression support
- **WHEN** a client connects without accepting per-message compression
- **THEN** every message to it is sent uncompressed, whatever the setting
