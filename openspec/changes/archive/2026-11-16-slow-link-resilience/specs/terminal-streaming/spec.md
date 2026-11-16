## ADDED Requirements

### Requirement: Connect timeouts grow with the link's handshake time
The client SHALL start with a 3 s connect timeout and SHALL double it after each consecutive connect attempt that times out, up to 24 s. A successful connect SHALL set the next attempt's timeout to three times the handshake time it observed, but no less than 3 s and no more than 24 s. The longer timeout for the first attempt after a resume SHALL be kept whenever it is greater.

#### Scenario: A slow handshake eventually connects
- **WHEN** every handshake takes 4 s
- **THEN** the first attempt times out at 3 s, the second waits 6 s and connects, and the client does not keep retrying at the same timeout

#### Scenario: Escalation is capped
- **WHEN** connect attempts keep timing out
- **THEN** the timeouts are 3 s, 6 s, 12 s, 24 s, and every later attempt also waits 24 s

#### Scenario: A fast link keeps fast failure detection
- **WHEN** the previous connect completed its handshake in 200 ms
- **THEN** the next connect attempt times out after 3 s

#### Scenario: A slow link keeps its learned timeout
- **WHEN** the previous connect completed its handshake in 5 s
- **THEN** the next connect attempt times out after 15 s

### Requirement: Resume verification waits for the measured round trip
The client SHALL measure the round-trip time of the connection's heartbeat pings and keep a smoothed estimate. The resume-verification deadline SHALL be three times that estimate, but no less than 1.5 s and no more than 8 s. A client without a measurement yet SHALL use 1.5 s.

#### Scenario: A slow but live link passes verification
- **WHEN** the smoothed round trip is 1 s and the page resumes on a live socket that answers in 1.2 s
- **THEN** the deadline is 3 s, verification passes, and the client does not force a reconnect

#### Scenario: A dead socket on a fast link is still caught quickly
- **WHEN** the smoothed round trip is 50 ms and the page resumes on a socket that never answers
- **THEN** verification fails after 1.5 s and the client forces a reconnect

#### Scenario: The deadline is capped
- **WHEN** the smoothed round trip is 5 s
- **THEN** the verification deadline is 8 s
