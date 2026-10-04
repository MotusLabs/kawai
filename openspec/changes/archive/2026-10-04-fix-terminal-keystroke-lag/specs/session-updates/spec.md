# Spec Delta

## Purpose

Defines how session state changes are detected, broadcast, and rendered: updates
propagate promptly for meaningful changes while steady activity churn does not
flood clients or trigger re-render storms.

## ADDED Requirements

### Requirement: Session broadcasts fire only on meaningful changes
The server SHALL detect session-list changes against activity timestamps
quantized to 30-second buckets, and SHALL NOT broadcast a session-list update
when only sub-quantum activity changed. Stored and emitted activity timestamps SHALL retain full precision and
SHALL never regress during replacement. Creation timestamps SHALL be unaffected.
Only change detection SHALL use buckets; invalid timestamps SHALL retain raw
comparison behavior. Activity-only recency and label updates may be delayed
until a bucket crossing, but emitted timestamps SHALL preserve precise
status-sort tie-breakers.

#### Scenario: Sub-quantum churn produces no broadcast
- **WHEN** a window's content changes repeatedly within one 30-second bucket
  and no other field changes
- **THEN** no session-list update is broadcast for those changes

#### Scenario: Meaningful changes still broadcast
- **WHEN** a session's status, name, membership, or another non-activity field
  changes, or its activity crosses into a new bucket
- **THEN** a session-list update is broadcast

#### Scenario: Immediate working status on Enter is preserved
- **WHEN** the user presses Enter in a session
- **THEN** that session's working-status update is still delivered
  immediately, outside the quantization cadence

### Requirement: Session rows do not re-render on activity-only churn
The client SHALL NOT re-render a session row when only its activity timestamp
changes within the quantized bucket, and SHALL re-render it when status or
other displayed fields change. Relative-time labels SHALL refresh from a
periodic tick independent of broadcasts.

#### Scenario: Activity-only update skips the row
- **WHEN** a session-list update arrives whose only change for a row is its
  activity timestamp within the same bucket
- **THEN** that row is not re-rendered

#### Scenario: Status change re-renders the row
- **WHEN** a session's status changes
- **THEN** its row re-renders with the new status

#### Scenario: Labels stay fresh without broadcasts
- **WHEN** no meaningful session changes occur for several minutes
- **THEN** relative-time labels still refresh on the periodic tick

#### Scenario: Updated action callback remains current
- **WHEN** a row's action callback or optional action availability changes
- **THEN** the row uses the latest callback and displays the current actions

#### Scenario: Precise timestamps survive suppression
- **WHEN** activity changes inside a bucket without an emitted list update
- **THEN** the registry stores the precise latest timestamp and includes it
  in the next emitted payload, preserving recency ordering within that bucket

### Requirement: Terminal chrome inputs stay referentially stable
The client SHALL keep the session-derived data passed to the terminal control
strip referentially stable across renders that do not change that data, so the
strip re-renders only when its inputs change.

#### Scenario: Unrelated re-render leaves the strip alone
- **WHEN** the surrounding terminal view re-renders without session data
  changes relevant to the strip, including when a new sessions array differs
  only in activity timestamps
- **THEN** the strip does not re-render
