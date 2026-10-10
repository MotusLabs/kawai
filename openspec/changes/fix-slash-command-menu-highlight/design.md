# Design

## Context

See proposal.md for the motivation. The slash-command menu already handles
Up/Down/Tab/Enter/Escape and pointer selection; the unit tests in
`chatComponents.test.tsx` cover those keys and pass. The failure is purely
visual: `SlashCommandMenu.tsx` styles the highlighted row with
`bg-primary-accent text-primary` and the unhighlighted rows with
`hover:bg-elevated`, and both rules are no-ops.

- `bg-primary-accent` is not a color in `tailwind.config.js` (which defines
  `primary` and `accent` as separate colors). Tailwind emits no
  `.bg-primary-accent` rule — confirmed by grepping the built stylesheet.
- `text-primary` is inherited from the chat root, so it changes nothing.
- The menu container is `bg-elevated`, and so is `hover:bg-elevated`, so hover
  is the same color as the surface it sits on.

## Goals / Non-Goals

**Goals:**
- The option that Tab/Enter will insert is always visibly marked.
- Hover feedback is visible against the menu surface.
- A regression test catches dead theme utilities in this component before
  another invisible-highlight bug ships.

**Non-Goals:**
- Changing keyboard behavior, filtering, ranking, or the choose/dismiss rules.
- A repo-wide lint for unused Tailwind color utilities.
- Fixing the `text-error` / `bg-error` / `border-error` classes in `Toast.tsx`
  and `SettingsModal.tsx` (noted in the proposal; separate change).

## Decisions

**Selected style: `bg-accent/20 text-accent`.**
Matches the existing "active/selected" idiom already used by `TerminalControls`
(`bg-accent/20 text-accent border-accent/40`) and by the selected badge pattern
(`bg-accent/15 text-accent`). `--accent` is defined in every theme, including
the chat palette (`#539bf5` on `#2d333b`), so the tint stays visible in both.
Alternatives:
- `bg-hover` — too close to hover, so keyboard selection and hover would look
  identical; rejected.
- `bg-accent text-white` — the primary-button treatment, too heavy for a list
  row that can hold five matches; rejected.
- A new CSS class in `index.css` — extra surface for one row; rejected.

**Hover style: `hover:bg-hover`.**
`--bg-hover` is defined for every theme and is lighter than `--bg-elevated` in
the chat palette (`#373e47` vs `#2d333b`), so hover reads as a lift off the
menu. The selected row keeps its accent tint and does not also take the hover
background (selected wins), which is the current class structure.

**Regression test: assert the menu's class names resolve to theme tokens.**
A small unit test walks the `bg-*` / `text-*` utilities used by
`SlashCommandMenu.tsx` and asserts each color segment is a key in
`tailwind.config.js` `theme.extend.colors` (or a default Tailwind palette
color). This is the cheapest check that fails on `bg-primary-accent`-style
typos without needing a browser. Alternatives:
- Playwright computed-style check — real, but heavyweight for a class typo and
  the chat e2e path is flaky (see project memory); rejected as the only guard.
- Contrast assertion in `chatPalette.test.ts` — useful, but that file tests CSS
  tokens, not component class names; not sufficient alone.

## Risks / Trade-offs

- [The class-utility test only covers this component] → Acceptable: the bug is
  local. A repo-wide utility audit is a separate concern.
- [`bg-accent/20` alpha may read differently on the light theme] → `--accent`
  is opaque in both themes and the existing `bg-accent/20` usages already rely
  on this; visual check on light + chat palette during apply.
- [Tests that assert class name strings are brittle under restyling] → Keep the
  test on the *tokens* (theme keys), not exact class strings, so a future
  retune of the alpha still passes if the color exists.
