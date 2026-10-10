# Proposal

## Why

The slash-command menu's keyboard navigation is implemented and tested, but the
highlighted option is invisible in the browser. Arrow Up/Down and Tab work with
no visual feedback, so the menu feels dead and users cannot tell which option
Tab will insert. The cause is two dead style rules in `SlashCommandMenu.tsx`,
not missing key handling.

## What Changes

- Give the highlighted option a real, visible selected style built from defined
  theme tokens (the current `bg-primary-accent` is not a Tailwind color and
  produces no CSS at all).
- Give unhighlighted options a hover style that actually differs from the menu
  background (`hover:bg-elevated` is currently the same color as the menu).
- Tighten the slash-command menu requirement so a visible highlight is required
  behavior, not an implementation detail — this bug shipped because "operable
  by keyboard" never said the selection must be seen.
- Add a regression test that fails if the menu's selected/hover classes stop
  resolving to tokens defined in `tailwind.config.js`.

Keyboard behavior itself (Up/Down wrap, Tab/Enter choose, Escape dismiss,
Enter falls through with no match) is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: the composer slash-command menu requirement gains an explicit
  visible-selection requirement (the highlighted option is distinguishable from
  the others; hover feedback is distinguishable from the menu surface).

## Impact

- `src/client/components/chat/SlashCommandMenu.tsx` — selected and hover class
  names.
- `openspec/specs/chat-sessions/spec.md` — via the delta in this change.
- `src/client/__tests__/chatComponents.test.tsx` (and/or a small unit test on
  the class names) — regression coverage.
- No server, protocol, or API changes. No dependency changes.

### Related finding (out of scope)

`Toast.tsx` and `SettingsModal.tsx` use `text-error` / `bg-error` / `border-error`,
which are also undefined Tailwind colors (the theme defines `danger`). Those are
a separate one-line fix and are deliberately left out of this change.
