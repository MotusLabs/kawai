## ADDED Requirements

### Requirement: Tool metrics
Kawai SHALL report, for the window:
- tool failure rate: failed results over all recorded results, broken down by tool and failure class;
- the first-attempt success rate of `kawai-team` tools: the share of each turn's first call to a tool that succeeded;
- abandoned streaks;
- mean failures before recovery over `recovered` streaks.

They SHALL carry the turn attribution side, so they slice by group and profile.

#### Scenario: Misleading schema shows up
- **WHEN** in the window `task_submit_result` succeeded on 2 of 10 first attempts and every other `kawai-team` tool on all of them
- **THEN** the first-attempt breakdown reads 20% for `task_submit_result` with `n = 10`

#### Scenario: Weak model gives up more
- **WHEN** the window holds three abandoned streaks, all on one profile
- **THEN** slicing by profile shows all three under that profile

### Requirement: Tool metric drill-down opens the failing call
The Tools family's drill-down SHALL list the window's abandoned streaks and its five longest recovered streaks, each naming the tool, length, session, and time. Opening one SHALL open its chat at the streak's first failed call.

#### Scenario: Open an abandoned streak
- **WHEN** the human opens an abandoned streak in the 3d window
- **THEN** its chat opens with the first failed tool call revealed
