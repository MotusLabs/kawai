# notification-sounds Specification

## Purpose
Defines when the dashboard plays audible notifications for session status transitions, so users hear about sessions that need attention without being chimed at for the session they are already watching.

## Requirements

### Requirement: Idle sound on working-to-waiting transitions
When the Idle Sound setting is enabled, the dashboard SHALL play the Idle sound when a known session's status changes from `working` to `waiting`, whether the change arrives in a full session list or a single session update, unless the selected-session exception applies.

#### Scenario: Background session finishes
- **WHEN** Idle Sound is enabled and a session that is not selected changes from `working` to `waiting`
- **THEN** the Idle sound plays

#### Scenario: Idle Sound disabled
- **WHEN** Idle Sound is disabled and any session changes from `working` to `waiting`
- **THEN** no Idle sound plays

#### Scenario: Newly appearing session
- **WHEN** a session the client did not know before first appears with status `waiting`
- **THEN** no Idle sound plays

### Requirement: No Idle sound for the watched session
The dashboard SHALL NOT play the Idle sound for a `working` to `waiting` transition of the session that is currently selected, shown because no Team page is open, while the dashboard page is visible. When the page is hidden or a Team page is open, the selected session's transition SHALL play the Idle sound as for any other session.

#### Scenario: Selected session finishes while the user is watching
- **WHEN** Idle Sound is enabled, the dashboard page is visible, no Team page is open, and the selected session changes from `working` to `waiting`
- **THEN** no Idle sound plays

#### Scenario: Selected session finishes in a background tab
- **WHEN** Idle Sound is enabled, the dashboard page is hidden, and the selected session changes from `working` to `waiting`
- **THEN** the Idle sound plays

#### Scenario: Selected session finishes while the Team page is open
- **WHEN** Idle Sound is enabled, the page is visible, and the Team page is open while the selected session changes from `working` to `waiting`
- **THEN** the Idle sound plays

#### Scenario: Selected and background sessions finish together
- **WHEN** Idle Sound is enabled, the page is visible, and one session list moves both the selected session and a non-selected session from `working` to `waiting`
- **THEN** the Idle sound plays for the non-selected session

#### Scenario: Settings preview
- **WHEN** the user presses the Idle sound preview in Settings
- **THEN** the Idle sound plays regardless of selection or page visibility

### Requirement: Permission sound for every session
When the Permission Sound setting is enabled, the dashboard SHALL play the Permission sound when a known session's status changes to `permission` from any other status, including for the selected session while the page is visible.

#### Scenario: Selected session asks for permission
- **WHEN** Permission Sound is enabled, the page is visible, and the selected session changes from `working` to `permission`
- **THEN** the Permission sound plays

#### Scenario: Background session asks for permission
- **WHEN** Permission Sound is enabled and a session that is not selected changes from `working` to `permission`
- **THEN** the Permission sound plays
