# Design

## Context

Chrome on Android resizes only the visual viewport for the soft keyboard
(`interactive-widget=resizes-visual`, the default since Chrome 108). The
layout viewport, `100dvh`, and `#root` (`height: 100dvh`, `index.css`) keep
their full height; the bottom-pinned composer ends up under the keyboard.
`useVisualViewport` (mounted in `App.tsx`) already writes
`--visual-viewport-height`, `--keyboard-inset` and the `keyboard-visible`
class on every device, but `index.css` consumes the height only under
`.ios #root` (inside `@media (max-width: 767px)`) and
`.ios .terminal-mobile-overlay`. `main.tsx` adds `ios` and `ios-pwa` classes
through `src/client/utils/device.ts`; there is no Android check. `Terminal.tsx`
refits on `visualViewport` `resize`, so a shrinking viewport reaches the
terminal pane without new code. `index.html` has one viewport meta,
`width=device-width, initial-scale=1.0, viewport-fit=cover`, and no
`interactive-widget`.

```
 Android today                       After (option A)
 layout viewport = full height       layout viewport = height above keyboard
 +------------------+                +------------------+
 | header           |                | header           |
 | transcript       |                | transcript       |
 | [composer]       | <- covered     | [composer]       |
 +==================+                +==================+
 | keyboard         |                | keyboard         |
 +------------------+                +------------------+
```

## Goals / Non-Goals

**Goals:**
- The composer is never covered by the Android keyboard, in a tab and in the
  installed PWA, and the transcript stays scrollable with the keyboard open.
- The meta, startup and keyboard behaviour of iOS and desktop are untouched.

**Non-Goals:**
- Load-time or snapshot work (separate change `bounded-chat-snapshot`).
- Android-specific styling beyond the keyboard, a custom virtual keyboard, or
  scrolling the composer into view by script.

## Decisions

### Decision 1: Add `interactive-widget=resizes-content` on Android only, at startup

`main.tsx`, beside the `ios` classes and before the app mounts, calls
`applyAndroidViewport()`: when `isAndroidDevice()` (new in `device.ts`: the
user agent contains `Android`, never true for an iOS user agent), it appends
`interactive-widget=resizes-content` to the existing viewport meta content,
once (idempotent, the three existing tokens kept as they are). The browser
then resizes the layout viewport, so `100dvh` and every flex child follow
without more JavaScript. Blink re-parses the viewport when the meta's
`content` attribute changes, which is why a runtime opt-in is expected to
work; the owner's device check (task 2.1) is the proof, because Playwright
cannot show a keyboard.

| Option | Cost | Risk |
|---|---|---|
| A. static token in `index.html` | one attribute | reaches every engine that supports it, WebKit included: if layout and visual heights converge, `useVisualViewport` derives inset 0, drops `keyboard-visible`, and `index.css` applies the keyboard-hidden safe-area padding, an unverified change to iOS |
| A'. runtime token on Android (chosen) | one helper and one call | depends on Chrome honouring the meta mutation; desktop-site mode (no `Android` in the user agent) keeps today's behaviour |
| B. apply `--visual-viewport-height` to `#root` for Android too | CSS plus a class | more JavaScript in the layout path; two mechanisms to keep in step |

A' is chosen: iOS and desktop startup is byte-for-byte unchanged (no meta
mutation, no class, no listener), and the browser's own layout cannot drift
from it. Rejected alongside: an inline script in `index.html` (a second copy of
the Android detection), and a server-side rewrite by user agent (the service
worker precaches `index.html`).

### Decision 2: B is a fallback for the Android standalone PWA, decided by the owner's device check

Task 3.1 runs only if the owner's check (task 2.1) shows, in the installed
Android PWA after loading this candidate, that the composer is still hidden
while the visual viewport shrank. Three recorded readings must hold together:

1. **Occlusion.** With the keyboard open, the composer rectangle's bottom is
   below the visual viewport's bottom, measured as `offsetTop + height`, both
   in the same CSS-pixel coordinate space and at the same page scale as the
   keyboard-closed baseline.
2. **Candidate loaded.** The page's viewport meta content contains
   `interactive-widget=resizes-content` and the build id matches this
   candidate.
3. **Viewport shrank.** `visualViewport.height` is below its keyboard-closed
   value by about the keyboard height.

A failing browser tab, or missing candidate or viewport evidence, does not
trigger the fallback: it returns to design. The fallback is a new
`android-pwa` class, set in `main.tsx` when `isAndroidDevice()` and
`matchMedia('(display-mode: standalone)').matches`, and one new block in
`index.css`:

```css
@media (max-width: 767px) {
  .android-pwa #root { height: var(--visual-viewport-height, 100dvh); }
}
```

It changes the root's height only (no `position`, no `transform`), it never
edits a `.ios` rule, and it leaves `useVisualViewport.ts` and the
`keyboard-visible` class alone. Its outcome is stated as geometry: with the
keyboard open `#root` is as tall as the visual viewport (within 1 px) and the
composer's bottom edge is at or above `offsetTop + height`; after the
keyboard closes `#root` is back to the dynamic viewport height.

### Decision 3: No change to the terminal pane

`Terminal.tsx` refits on `visualViewport` `resize` and the terminal overlay
is `flex-1` inside `#root`, so a shorter `#root` shrinks it. The existing
`.ios .terminal-mobile-overlay` rules stay iOS-only.

## Risks / Trade-offs

- Chrome below 108 and Samsung Internet versions that ignore the key keep the
  old behaviour: accepted, not detected.
- If Chrome ignores a runtime change to the meta, task 2.1 fails in the tab
  as well as the PWA: the change then goes back to design, not to the
  fallback.
- With `resizes-content` the transcript area shrinks while typing.
  `ChatSurface` keeps the transcript stuck to the bottom when its content
  changes and has no dependency on the viewport, and `useHistoryAnchor` only
  reacts to prepended history, so this change does not claim the bottom row
  stays in view on opening; the owner records it as an observation from a
  known initial bottom position, and requires only that the transcript scrolls
  while the keyboard is open.
- Playwright cannot show the keyboard: its mobile emulation does not open a
  soft keyboard or resize the layout viewport. The automated checks cover the
  served page, the meta for each user agent, and the iOS root rule; the
  keyboard behaviour is the owner's device task and is reported as such.

## Open Questions

None blocking. Whether Chrome honours the runtime meta, and whether B is
needed, are answered by the owner's task 2.1.

## Acceptance oracles

Automated rows run in `tests/e2e/mobile-viewport.spec.ts` against the
production client the e2e server serves (`dist/client`, run `bun run build`
first) under the repository's private e2e fixture and home directories; the
unit rows run in `src/client/__tests__/device.test.ts`. Device rows are the
owner's and are reported with their status (done, or not run), never inferred
from the automated rows.

| id | Context | Expected | Negative control |
|---|---|---|---|
| M1 | served `index.html` fetched without running scripts | viewport meta content is exactly `width=device-width, initial-scale=1.0, viewport-fit=cover` | a static token added to `index.html` fails M1 |
| M2 | Android phone profile (412 px), page loaded | meta content is exactly the three existing tokens plus `interactive-widget=resizes-content`, once; no `ios` class | token removed fails M2 |
| M3 | M2 reloaded, and the helper called twice | the token is still present once | non-idempotent append fails M3 |
| M4 | iPhone profile (390 px) loaded and reloaded; desktop context loaded and reloaded | meta content equals the M1 string exactly; no `android-pwa` class | token added for every user agent fails M4 |
| M5 | iPhone profile (390 px), `ios` class, `--visual-viewport-width` 321px, `--visual-viewport-height` 457px, `--viewport-offset-left` 7px, `--viewport-offset-top` 13px set on the root element | `#root` computed `position` is `fixed`, width 321 px, height 457 px, transform translate (7 px, 13 px) | `.ios #root` block deleted, or its size or offset declarations dropped, fails M5 |
| M6 | the same variables at 768 px and wider with the `ios` class | `#root` computed `position` is not `fixed` and carries no iOS size or offset | breakpoint widened or removed fails M6 |
| M7 | `isAndroidDevice` unit: Android phone and tablet user agents; iPhone, iPad, desktop Chrome, Mac | true for the Android user agents, false for the others | an iOS user agent matched fails M7 |
| M8 | if task 3.1 runs: Android user agent, standalone display mode, 412 px; then browser display mode; then 800 px | `android-pwa` set only in the first; the block is inside the 767 px query | class set in browser mode fails M8 |
| D1 | owner, Android Chrome tab and installed PWA, a chat whose transcript overflows one screen | per task 2.1: composer above the keyboard, a scroll gesture changes the transcript scroll position with the keyboard open, the layout restores after dismissal | status "not run" until the owner records it |

## Implementation contract

### Acceptance

- A1: The served `index.html` viewport meta is exactly `width=device-width, initial-scale=1.0, viewport-fit=cover`; an Android user agent gains `interactive-widget=resizes-content` at startup, once; iOS and desktop never do (M1–M4).
- A2: On an Android Chrome device, in a browser tab and in the installed PWA, a focused composer's bottom edge is above the keyboard and the transcript scrolls with the keyboard open (D1, owner check, recorded in the task journal with device and Chrome version, build id, and the meta content string).
- A3: Closing the keyboard restores the full-height layout on the same device (D1).
- A4: The iOS rules in `index.css` (`.ios #root`, `.ios .terminal-mobile-overlay`, `.ios-pwa .terminal-mobile-overlay`, `.ios:not(.keyboard-visible) #root`) and `useVisualViewport.ts` are byte-identical to master; task 3.1, if it runs, only adds an `.android-pwa` block (M5, M6).

### Invariants

- I1: `#root` height stays `100dvh`; no rule gives it a keyboard-dependent height outside the `ios` class and, if task 3.1 runs, the `android-pwa` class.
- I2: No behaviour is added for a user agent without `Android`, and none for the desktop layout (`md:` and wider).

### Scope

- `src/client/utils/device.ts`
- `src/client/main.tsx`
- `src/client/styles/index.css`
- `src/client/__tests__/device.test.ts`
- `tests/e2e/mobile-viewport.spec.ts`

### Verification

- V1: Rows M1 to M7 pass in the served-page e2e test and the device unit test, each with its negative control, and each automated scenario of the `mobile-viewport` delta is cited by a literal `@covers` annotation.
- V2: `git diff origin/master -- src/client/hooks/useVisualViewport.ts` is empty, and the `index.css` diff edits no `.ios` rule (A4).
- V3: The owner's device check (row D1) is recorded for both modes with: device model, Chrome version, build id, the viewport meta content string; the composer rectangle and the visual viewport bottom (`offsetTop + height`) in the same CSS-pixel space with the keyboard closed and open; the transcript's scroll position before and after a scroll gesture with the keyboard open; and the root and composer geometry after dismissal. Whether the bottom row stays visible is recorded as an observation only.
- V4: `bun run build` and `bun run check` pass on the clean committed tree.

### Excluded

- X1: No change to `index.html`, `Terminal.tsx`, the chat composer components, `useVisualViewport.ts`, or the WebSocket client.
- X2: No JavaScript scroll-into-view for the composer.
- X3: No behaviour change for iOS or desktop.
