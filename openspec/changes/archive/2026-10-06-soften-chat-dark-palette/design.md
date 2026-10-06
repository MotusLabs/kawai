# Design

## Context

Theme colors are CSS custom properties in `src/client/styles/index.css`.
`:root, [data-theme="dark"]` and `[data-theme="light"]` each define them, and
`App.tsx` sets `data-theme` on `<html>` (`Theme = 'dark' | 'light'`).
`tailwind.config.js` maps the properties to color names (`bg-base`,
`text-primary`, `border-border` and so on), and `.btn`, `.btn-primary` and
`.input` read them too. Chat components use these names almost everywhere.
They also hard-code four Tailwind palette colors:

- `text-red-400` for errors in `ChatMessages.tsx` and the `ChatView.tsx`
  banner.
- `text-sky-400`, `text-emerald-400` and `text-amber-400` for the Debug panel's
  direction labels in `ChatDebugPanel.tsx`.

`ChatView`'s root `<main>` contains the header, transcript, requests, composer
and Debug panel, so it is the natural boundary for the scope.

## Goals / Non-Goals

**Goals:**
- One place that defines the chat dark palette, picked up by every existing
  token-based class without editing each component.
- Contrast bounds from the spec, enforced by a unit test so later token edits
  can't silently regress them.

**Non-Goals:**
- A user-selectable chat theme or a third global theme.
- Changing `.btn` and `.input` outside the chat view.
- Changing the `::selection` color and scrollbar styling. They already derive
  from tokens or are neutral.

## Decisions

### 1. Re-declare the existing tokens inside a chat scope

Add a `chat-palette` class to `ChatView`'s `<main>`. In `index.css`, add a
dark-only rule that redefines the existing custom properties for that subtree:

```css
:root:not([data-theme="light"]) .chat-palette { … }
```

The selector matches today's dark default, which applies when `data-theme` is
missing or set to `dark`. Custom properties inherit, so `bg-base`,
`text-secondary`, `.btn`, `.input` and the rest change inside the chat pane
only.

- *Alternative: new `chat-*` token names and Tailwind classes.* Every chat
  component would have to switch class names, and the markdown renderer
  shared with the session preview (from `fix-chat-markdown-rendering`) would
  need a chat variant. Re-declaring the existing names avoids both.
- *Alternative: change the global dark tokens.* The user chose to limit the
  change to the chat view.

### 2. Token values from GitHub Primer "Dark Dimmed"

| Token | Value | Primer role | Contrast |
|---|---|---|---|
| `--bg-base` | `#22272e` | canvas.default | — |
| `--bg-elevated` | `#2d333b` | canvas.overlay (user bubble, cards) | — |
| `--bg-surface` | `#2d333b` | canvas.subtle (buttons, inline code) | — |
| `--bg-hover` | `#373e47` | neutral.muted | — |
| `--text-primary` | `#adbac7` | fg.default | 7.6 on base, 6.45 on elevated |
| `--text-secondary` | `#909dab` | between fg.default and fg.muted | 5.44 on base, 4.61 on elevated |
| `--text-muted` | `#768390` | fg.muted | 3.88 on base (metadata only) |
| `--border` | `#444c56` | border.default | — |
| `--border-subtle` | `#373e47` | border.muted | — |
| `--accent` | `#539bf5` | accent.fg (links, focus ring) | 5.28 on base |
| `--chat-danger` | `#f47067` | danger (red.4) | 5.27 on base |
| `--chat-wire-out` | `#6cb6ff` | blue.3 | 6.99 on base |
| `--chat-wire-in` | `#6bc46d` | green.3 | 6.97 on base |
| `--chat-wire-stderr` | `#daaa3f` | yellow.3 | 7.01 on base |

Status tokens (`--working`, `--approval`, `--waiting` and `--danger`) are
re-declared with the matching Primer `.fg` shades, so any status color used
inside the pane stays consistent with the palette.

`--text-secondary` uses `#909dab` rather than Primer's `#768390`. Secondary
text is small (`text-xs`) and has to meet 4.5:1 on the user bubble
(`#2d333b`), and `#768390` only reaches 3.29 there. `--text-muted` keeps
`#768390`. It is used only for the "Turn complete" metadata line and frame
timestamps, which the spec doesn't hold to 4.5:1.

`--text-secondary` on `--bg-hover` (`#373e47`) measures 3.91. Hover states
apply to `.btn`, whose hover rule already switches the text to
`--text-primary` (5.47), so this pairing doesn't occur.

### 3. Primary buttons use Primer's emphasis blue

`--accent` (`#539bf5`) works for links, but white text on it measures only
about 2.9:1. A scoped rule sets `.chat-palette .btn-primary` to
`#316dca` (accent.emphasis, 5.03 with white) and its hover to `#2a5fb3` (6.2).
This leaves the global `.btn-primary` rule alone.

### 4. Hard-coded colors become tokens

Expose `--chat-danger` and the three `--chat-wire-*` tokens through
`tailwind.config.js` as `chat-danger`, `chat-wire-out`, `chat-wire-in` and
`chat-wire-stderr`. The dark-default and light rules give them values that
equal today's Tailwind colors. Dark gets `red-400`, `sky-400`, `emerald-400`
and `amber-400`. Light gets the same, since today's light theme uses those
colors too. The chat scope then overrides them. The light theme's appearance
is unchanged, as the spec requires.

### 5. Test the contrast at the CSS level

Add `src/client/__tests__/chatPalette.test.ts`. It reads `index.css` as text,
extracts the `.chat-palette` declarations, and asserts the spec's bounds with
a small WCAG relative-luminance helper:

- primary on base: ≥7 and ≤10.
- secondary on base and on elevated: ≥4.5.
- danger and each wire color on base: ≥4.5.
- white on the scoped `.btn-primary` background and on its hover: ≥4.5.

A component test in `chatComponents.test.tsx` asserts that `ChatView`'s root
carries `chat-palette`, and that error and Debug-direction elements use the
token classes instead of `red-400`, `sky-400`, `emerald-400` or `amber-400`.

## Risks / Trade-offs

- [The chat pane (`#22272e`) sits next to the near-black navigator
  (`#0a0a0a`), which gives a visible seam] → The pane's existing left border
  already separates them, the same way an editor pane sits next to a sidebar.
  Verify with a dev-browser screenshot. If it looks wrong, adopting the
  palette app-wide is a follow-up.
- [Modals and popovers rendered through a portal outside `<main>` don't
  inherit the scope] → This matches the spec's "rest of the app unchanged"
  rule. The archive confirmation is a native `confirm()`, so it isn't
  affected.
- [Merge overlap with `fix-chat-markdown-rendering`, which also edits
  `ChatMessages.tsx`] → This change touches only the error line in that file.
  The shared renderer reads tokens, so it picks up the palette with no extra
  work, whichever change lands first.
- [`:not()` selector specificity] → `:root:not([data-theme="light"])
  .chat-palette` (0,3,0) outranks both `:root` and `[data-theme="dark"]`
  (0,1,0), so the scoped values win inside the pane.

## Migration Plan

This is CSS and class-name only. Rollback is reverting the commit. No data or
settings change.
