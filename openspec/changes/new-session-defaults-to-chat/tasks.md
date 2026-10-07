# Tasks

## 1. Kind default recalculated at open

- [ ] 1.1 Add the `defaultKind(initialAutoStartChange)` helper and call `setKind(defaultKind(initialAutoStartChange))` in the closed→open branch of the lifecycle effect in `src/client/components/NewSessionModal.tsx` (the close branch no longer sets kind; the `useState` initializer seeds the generic default); verify with a unit test that a generic open preselects chat (profile selector visible, no command presets)
- [ ] 1.2 Test the change-section entry point: with `initialAutoStartChange` set, an open preselects Terminal and the "Start with" selector is visible
- [ ] 1.3 Test both entry-point switch sequences: generic open → close → change-section open preselects Terminal; change-section open → close → generic open preselects Claude Code chat
- [ ] 1.4 Test kind switching preserves the entered project path and display name

## 2. Provisional initial focus with chat preselected

- [ ] 2.1 Attach `defaultButtonRef` to the Create submit button when `kind === 'chat'`; at the initial focus attempt, focus Create when enabled and the session-kind select when Create is disabled (catalog still loading); test both paths, driving the catalog with a deferred promise for the delayed response
- [ ] 2.2 Add the catch-up: when the catalog settles successfully while the dialog is open with chat kind, move focus to the now-enabled Create only if the currently focused element is still the dialog's provisional one (tracked via a ref); test with a delayed catalog response and assert a user-moved focus is never stolen
- [ ] 2.3 Test the catalog-error path: initial focus lands on the session-kind select, and settling with an error leaves focus there without crashing

## 3. Full verification

- [ ] 3.1 Run `bun run lint && bun run typecheck && bun run test` and fix any failures
- [ ] 3.2 Verify in the running app with the `dev-browser` skill: ⌘N opens the dialog with Claude Code chat preselected and the dialog keyboard-operable while profiles load; a change-section action opens it with Terminal preselected

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
