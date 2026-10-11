# Proposal

## Why

The Idle sound tells the user that a session finished working and wants attention. When that session is the one already selected and the dashboard tab is visible, the user is looking at it as it finishes, so the chime only adds noise — and it fires on every turn of the session they are actively working in.

## What Changes

- The Idle sound is not played when the session that went from working to waiting is the currently selected session and the dashboard page is visible.
- The Idle sound still plays for the selected session when the page is hidden (background tab, minimized window), and for every non-selected session as before.
- Both client paths that detect status transitions (full `sessions` snapshots and single `session-update` messages) apply the same rule.
- The Permission sound is unchanged: it still plays for every session, selected or not, because a pending approval blocks the agent.
- No setting is added; the existing Idle Sound toggle still enables or disables the sound overall, and its preview button still plays unconditionally.

## Capabilities

### New Capabilities
- `notification-sounds`: when the dashboard plays audible notifications for session status transitions (Permission and Idle sounds), gated by the user's sound settings and by whether the user is already watching the session.

### Modified Capabilities
<!-- None: no existing spec covers notification sounds. -->

## Impact

- `src/client/App.tsx`: the two status-transition sound blocks (`sessions` and `session-update` handlers).
- New small pure client module deciding which sounds a transition plays, with unit tests; `src/client/utils/sound.ts` playback is untouched.
- No server, protocol, settings, or storage changes.
