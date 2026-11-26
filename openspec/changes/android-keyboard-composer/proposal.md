# Proposal

## Why

On Android Chrome the soft keyboard covers the chat composer ("Message
Claude..."): selecting the text box opens the keyboard over the input, so the
user types blind. Chrome on Android (since 108) shrinks only the visual
viewport when the keyboard opens, so the layout viewport and `100dvh` keep
their full height and the bottom-pinned composer sits under the keyboard.
Kawai handles this only on iOS: `useVisualViewport` computes
`--visual-viewport-height` for every device, but `index.css` applies it under
`.ios #root`, and the viewport meta declares no `interactive-widget`.

## What Changes

- On Android only, add `interactive-widget=resizes-content` to the existing
  viewport meta before the app mounts, so Android Chrome resizes the layout
  viewport, and with it `100dvh`, when the keyboard opens. `index.html` is not
  changed, so the served meta, and the startup of iOS and desktop, stay as
  they are. A static token would also reach iOS engines that support it
  (WebKit has implementation evidence), where it could change the keyboard
  behaviour `useVisualViewport` and the `.ios` rules derive today.
- Add a fallback for the installed Android PWA only if the owner's device
  check shows, after loading this candidate, that the composer is still hidden
  while the visual viewport shrinks (design Decision 2; a conditional task,
  not part of the first pass). It changes the root's height only, at mobile
  width.
- Pin the invariant that the focused composer stays above the keyboard and
  the transcript stays scrollable with the keyboard open, in a browser tab
  and in the installed PWA, and that iOS behaviour does not change.
- No server, protocol, or data change.

## Capabilities

### New Capabilities
- `mobile-viewport`: how the app's layout follows the visible viewport on
  mobile browsers when the soft keyboard opens and closes.

### Modified Capabilities

None. No existing spec states soft-keyboard layout behaviour (searched
`chat-header`, `chat-sessions`, `workspace-navigation`, `terminal-streaming`).

## Impact

- `src/client/utils/device.ts` (an Android check), `src/client/main.tsx` (the
  runtime viewport opt-in and, if the fallback runs, one class), and
  `src/client/styles/index.css` (the fallback block only).
- `src/client/components/Terminal.tsx` is read, not changed: its
  `visualViewport` resize listener already refits the terminal.
- Tests: `src/client/__tests__/device.test.ts` and a new
  `tests/e2e/mobile-viewport.spec.ts` that checks the served page for Android,
  iOS and desktop. The keyboard itself is verified by the owner on a device
  (design, Verification).
