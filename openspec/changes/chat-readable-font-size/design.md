# Design

## Context

For motivation, see proposal.md (Why).

- `html, body { font-size: 13px }` (`src/client/styles/index.css`) sets the
  root size, so 1rem = 13px everywhere. Tailwind 3's `text-sm` is 0.875rem
  and `text-xs` is 0.75rem, so they render at 11.375px and 9.75px.
- The rest of the app (navigator, settings, terminal header) relies on these
  rem sizes, so changing the root size would resize the whole UI. That is out
  of scope.
- `.input` sets the composer to 16px to stop iOS zooming on focus.
- PR #24's `Markdown.tsx`:
  - The wrapper is `text-sm leading-6`.
  - Elements use rem sizes: `h1` is `text-base`, `h2`–`h6` are `text-sm`,
    and `pre` and `table` are `text-xs`.
  - Inline code is already `0.9em`.
  - The renderer is shared with `SessionPreviewContent.tsx`.
- `settingsStore` persists with `version: 7` and a custom `merge` that
  re-clamps pane fractions on hydrate. Terminal `fontSize` is clamped only in
  its setter.

## Goals / Non-Goals

**Goals:**
- Chat sizes come from one value: a `--chat-font-size` variable on the chat
  view root.
- `Markdown` inherits its size, so the same component works in the chat and
  in the preview.

**Non-Goals:**
- No change to the global root size or to `rem` usage outside the chat.
- No per-session size and no zoom shortcut.

## Decisions

1. **Scope the size with a CSS variable on the chat root, and size text in
   `em`.** `ChatView`'s `<main>` sets
   `style={{ '--chat-font-size': `${chatFontSize}px` }}` and the class
   `.chat-root { font-size: var(--chat-font-size, 15px) }`. Text inside uses
   `em`-based sizes.
   - *Alternative: change the root size.* Rejected because it resizes the
     whole app.
   - *Alternative: a Tailwind plugin to make `rem` relative to a variable.*
     Rejected because it adds complexity for a single view.

2. **Add two small Tailwind font sizes: `chat-body` (`1em`, line height 1.6)
   and `chat-meta` (`0.8em`, line height 1.4).** Add them under
   `theme.extend.fontSize`. Chat components swap `text-sm` → `text-chat-body`
   and `text-xs` → `text-chat-meta`. Named tokens keep the 0.8 ratio in one
   place and are easy to grep for.
   - *Alternative: arbitrary values (`text-[0.8em]`) at each call site.*
     Rejected because they spread the ratio across files.
   - Header buttons that use `.btn` (whose `@apply text-xs` is shared app
     chrome) get `text-chat-meta` in the chat header only. The `.btn`
     component itself is unchanged.

3. **`Markdown` inherits its size.**
   - The wrapper drops `text-sm` and `leading-6` and uses
     `leading-[1.6]`, so it takes the surrounding size.
   - Element sizes become em-relative: `h1` 1.25em, `h2` 1.125em, `h3`–`h6`
     1em (bold), `pre` and `table` 0.9em, and `li` drops `leading-6`.
   - `SessionPreviewContent` wraps `<Markdown>` in `text-sm leading-6`, so
     the preview looks as it does now.
   - This matches the modified requirement: same elements and proportions,
     different base size.

4. **Store `chatFontSize` next to `fontSize`.**
   - Default 15. `setChatFontSize` clamps to 12–20 and rounds to an integer.
   - The persist `merge` also sanitizes it (non-finite → 15, else clamp).
     This covers hand-edited storage and state persisted before the key
     existed, following the pane-fraction precedent.
   - No version bump: missing keys already take the default through the
     merge spread.

5. **Settings control.**
   - Copy the existing terminal "Font Size" −/+ stepper. Label it
     "Chat font size" with the hint "Chat text size in pixels (12-20)".
   - Put it in the same draft-and-save flow (`draftChatFontSize`), so it
     applies on Save like the other display settings.
   - Rename the terminal hint so the two are clearly distinct.

6. **Composer.** Replace the fixed 16px from `.input` with `text-chat-body`.
   On coarse pointers, apply `max(16px, 1em)` (via a small
   `.chat-composer` rule under `@media (pointer: coarse)`) so iOS doesn't
   zoom on focus.

7. **The Debug panel stays as it is.** It is a fixed-size monospace protocol
   view. It sits inside the chat root but keeps its `text-xs` rem sizing, so
   it doesn't scale.

## Risks / Trade-offs

- [Nested `em` compounds, e.g. `text-chat-meta` inside `text-chat-meta`
  gives 0.64em] → Apply size classes only on leaf text containers. Cover
  this with a computed-size check in the dev-browser verification.
- [Larger text makes long tool-call JSON blocks taller] → Tool call and
  result `<pre>` blocks stay at `chat-meta` (12px by default). That is still
  larger than today's 9.75px, which is intended.
- [PR #24 not merged yet, base drift from the palette change on master]
  → Rebase onto `master` after PR #24 merges, before applying. Its
  `text-red-400` → `text-chat-danger` changes do not overlap with the size
  changes.
- [Preview and chat visibly differ in size] → The modified requirement
  allows this. The preview is a compact peek view.

## Migration Plan

No data migration is needed. Users whose stored settings predate the key get
the 15px default on first load. To roll back, revert the change; the stored
`chatFontSize` key is then ignored.
