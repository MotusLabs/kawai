## ADDED Requirements

### Requirement: Outbound messages are never silently dropped
When a send on a connection is rejected at the server's backpressure limit, the server SHALL close that connection and log it with the buffered amount sampled at the last send over the limit, rather than drop a message while the connection stays open. The client SHALL then reconnect and resynchronise as after any other close.

#### Scenario: A slow client reaches the limit
- **WHEN** messages queued for one connection push its outbound buffer past the backpressure limit and a send is rejected
- **THEN** that connection is closed and the close is logged with the buffered amount, the rejected frame and every later send are never delivered, and the client may have read a contiguous prefix of the earlier accepted frames

#### Scenario: Below the limit nothing changes
- **WHEN** a connection's outbound buffer stays below the backpressure limit
- **THEN** every message is delivered in order and the connection stays open

#### Scenario: Other connections are unaffected
- **WHEN** one connection is closed at the backpressure limit
- **THEN** every other connection keeps receiving its messages

### Requirement: Any inbound message proves the connection alive
After sending a heartbeat or resume-verification ping, the client SHALL treat the connection as alive when any server message arrives before the deadline, not only the matching pong, and SHALL close and reconnect only when nothing arrives by then. Only a matching pong SHALL update the measured round-trip time that sets the resume deadline.

#### Scenario: A dead socket still reconnects
- **WHEN** the client sends a heartbeat ping and no message of any kind arrives within the pong deadline
- **THEN** the client closes the socket and reconnects

#### Scenario: A slow transfer keeps the connection
- **WHEN** the client sends a heartbeat ping while a large snapshot is downloading, and the snapshot finishes arriving before the deadline but the pong arrives after it
- **THEN** the connection is kept and the snapshot is applied

#### Scenario: Only a matching pong measures the round trip
- **WHEN** a matching pong arrives 1.2 seconds after its ping with no earlier sample, and a later resume verification starts
- **THEN** the verification deadline is 3.6 seconds, and a message that is not a matching pong takes no round-trip sample

#### Scenario: Resume verification accepts any message
- **WHEN** the client verifies a connection on resume and a session update arrives before the verification pong and within the verification deadline
- **THEN** the connection counts as verified and is not replaced
