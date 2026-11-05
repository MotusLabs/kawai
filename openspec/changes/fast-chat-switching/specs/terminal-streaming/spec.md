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

## ADDED Requirements

### Requirement: Outbound messages are never silently dropped
When a connection's outbound buffer reaches the server's backpressure limit, the server SHALL close that connection and log the close with the buffered amount, rather than drop a message while the connection stays open. The client SHALL then reconnect and resynchronise as after any other close.

#### Scenario: A slow client reaches the limit
- **WHEN** messages queued for one connection push its outbound buffer to the backpressure limit
- **THEN** that connection is closed, the close is logged with the buffered amount, and no later message is accepted on it

#### Scenario: Below the limit nothing changes
- **WHEN** a connection's outbound buffer stays below the backpressure limit
- **THEN** every message is delivered in order and the connection stays open

#### Scenario: Other connections are unaffected
- **WHEN** one connection is closed at the backpressure limit
- **THEN** every other connection keeps receiving its messages

### Requirement: Any inbound message proves the connection alive
After sending a heartbeat or resume-verification ping, the client SHALL treat the connection as alive when any server message arrives before the deadline, not only the matching pong, and SHALL close and reconnect only when nothing arrives by then.

#### Scenario: A dead socket still reconnects
- **WHEN** the client sends a heartbeat ping and no message of any kind arrives within the pong deadline
- **THEN** the client closes the socket and reconnects

#### Scenario: A slow transfer keeps the connection
- **WHEN** the client sends a heartbeat ping while a large snapshot is downloading, and the snapshot finishes arriving before the deadline but the pong arrives after it
- **THEN** the connection is kept and the snapshot is applied

#### Scenario: Resume verification accepts any message
- **WHEN** the client verifies a connection on resume and a session update arrives before the verification pong and within the verification deadline
- **THEN** the connection counts as verified and is not replaced
