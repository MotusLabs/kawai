# Tasks

## 1. Transition decision

- [x] 1.1 Add `src/client/utils/soundTransitions.ts` (header comment) with a pure function returning which sounds (`permission`, `idle`) a status transition plays given previous/next status, selected flag, page visibility, and the two sound settings; verify with `src/client/__tests__/soundTransitions.test.ts` covering every scenario in `specs/notification-sounds/spec.md` (background idle, settings off, unknown previous status, selected+visible suppressed, selected+hidden plays, permission for selected session)

## 2. App wiring

- [x] 2.1 Route the `sessions` handler in `src/client/protocol/sessionMessages.ts` through the decision function, using the pre-update `selectedSessionId` and `document.visibilityState`; verify the mixed-snapshot scenario (selected and background session idle together still chimes for the background one) via the unit tests and that the existing app tests pass
- [x] 2.2 Route the `session-update` handler in `src/client/protocol/sessionMessages.ts` through the same function with the same selection/visibility inputs; verify the inline transition conditions are gone (`grep -n "'waiting' && soundOnIdle" src/client/protocol/sessionMessages.ts` returns nothing) and app tests pass
- [x] 2.3 Note the selected-session exception in the Idle Sound description in `src/client/components/settings/GeneralSettings.tsx` and in the `CLAUDE.md` "How It Works" list; verify the settings test (if it asserts the description) is updated and passes

## 3. Verification

- [x] 3.1 Run `bun run lint && bun run typecheck && bun run test` and confirm all pass
- [ ] 3.2 In the running app with Idle Sound on, confirm no chime when the selected chat finishes a turn with the tab visible, and a chime when a non-selected session finishes or the tab is in the background
