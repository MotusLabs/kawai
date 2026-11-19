# Spec Delta

## ADDED Requirements

### Requirement: Tool metric reads avoid multiplicative history scans
Tool metric reads SHALL NOT re-examine a team's entire observation history for each completed turn or live session. They SHALL preserve the requested team's cohort, ordering, and single-read snapshot, including closure facts outside the tool-completion window. This applies to the Metrics tab, agent reads, and report generation.

#### Scenario: Large single-team history
- **GIVEN** a team has thousands of completed turns and unrelated retained observations
- **WHEN** its tool metrics are computed for a window and baseline
- **THEN** closure matching uses the relevant session and turn identities without repeating a team-wide history scan per completed turn
- **AND** returned closures are exactly those with matching tool completions in the requested interval, ordered by their recorded sequence

#### Scenario: Live sessions with unrelated history
- **GIVEN** live sessions and retained tool observations belong to the requested team
- **WHEN** tool metrics determine which sessions are live
- **THEN** matching examines each live session's observations without repeating a team-wide scan per live session
- **AND** a valid live turn remains represented when its session has an in-window tool completion, including one from another turn of that session

#### Scenario: Closure outside the completion window
- **WHEN** a tool completion is inside the requested interval and its same-session, same-turn closure is retained outside that interval
- **THEN** the closure is included with its existing coverage and taint information
- **AND** a completion exactly at the interval start is included and one exactly at the interval end is excluded

#### Scenario: Other identities cannot satisfy a match
- **WHEN** retained tool completions belong only to another team, another session, or another turn
- **THEN** they do not qualify a closure of the requested team, session, and turn

#### Scenario: Concurrent closure commit
- **WHEN** another connection commits a turn closure and removes its live state after the metrics read has established its snapshot
- **THEN** that metrics read keeps the original closure and live-state view
- **AND** a subsequent fresh read sees the committed closure and updated live state
