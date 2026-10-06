# Proposal

## Why

In the dark theme, chat messages are hard on the eyes. Body text is `#e5e5e5`
on a `#0a0a0a` background, a contrast ratio of about 15.7:1. That is near the
maximum possible and causes glare and halation in long transcripts.
Established dark palettes keep body text around 7–8:1 on a lifted gray
background, which still clears WCAG AA with a wide margin.

## What Changes

- In the dark theme, the chat view uses GitHub's "Dark Dimmed" palette
  (Primer) instead of the app-wide near-black tokens. The palette covers the
  transcript background, message text, the user-message bubble, borders, tool
  entries, approval and question cards, the composer and the Debug panel.
- Primary chat text drops from about 15.7:1 to about 7.6:1 contrast. Secondary
  text such as role labels and tool summaries stays at or above 4.5:1 on every
  chat surface.
- Hard-coded Tailwind colors inside the chat view follow the palette. These
  are the error text (`text-red-400`) and the Debug panel's direction colors
  (`sky`, `emerald` and `amber`).
- Out of scope:
  - The light theme.
  - The sidebar and navigator, terminal sessions and the xterm colors.
  - Modals and the rest of the app, which keep today's dark tokens.
  - Markdown element styling. That is covered by the separate
    `fix-chat-markdown-rendering` change. This change only supplies the colors
    that its renderer's theme tokens resolve to.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Adds a requirement for the chat view's dark-theme palette.
  It defines the contrast bounds for primary and secondary text, says which
  surfaces the palette covers and keeps the light theme and the rest of the
  app unchanged. No existing requirement is modified.

## Impact

- `src/client/styles/index.css`: a dark-only, chat-scoped override of the
  existing theme tokens (`--bg-*`, `--text-*`, `--border*` and `--accent`),
  plus palette tokens for error and the Debug panel's direction colors.
- `src/client/components/chat/ChatView.tsx`: the root `<main>` opts into the
  scope. The error banner uses the palette's danger token.
- `src/client/components/chat/ChatMessages.tsx`: error events use the danger
  token.
- `src/client/components/chat/ChatDebugPanel.tsx`: direction colors use the
  palette tokens.
- `tailwind.config.js`: may expose the new tokens as color names.
- Tests: `src/client/__tests__/chatComponents.test.tsx`, plus a CSS-level
  check of the token values and contrast ratios.
- Dependencies: none.
