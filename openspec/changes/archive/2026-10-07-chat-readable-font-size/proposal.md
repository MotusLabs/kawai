# Proposal

## Why

Chat view text is smaller than it should be for reading. The root `html`
element sets `font-size: 13px` for the terminal-style UI. Tailwind's text
sizes are in `rem`, so they shrink with it. Message bodies (`text-sm`) render
at about 11.4px, and labels, tool calls, notices and the turn footer
(`text-xs`) render at about 9.75px. Common guidance is 15–16px for body text
in reading-heavy UIs (13–14px at the low end for a dev tool) and at least
about 12px for secondary text. The composer textarea is fixed at 16px, so the
user types at 16px and replies come back at 11px.

This change builds on `fix-chat-markdown-rendering` (PR #24). That change adds
the shared `Markdown` renderer, which replaces the `prose` classes that did
nothing, but it also sizes in `rem` (`text-sm`, `text-xs`). Without this
change, formatted replies would still be too small.

## What Changes

- The chat view gets its own base font size, separate from the 13px root.
  Chat text sizes are relative to that base: body at 1em, and secondary text
  (role labels, tool calls, notices, turn footer, request details) at about
  0.8em.
- The default chat base size is 15px. At the default, body text is 15px and
  secondary text is 12px.
- Settings gets a "Chat font size" control (12–20px, default 15). It is
  separate from the terminal "Font Size" setting. The value persists like the
  other display settings. Out-of-range or invalid stored values are clamped,
  or replaced with the default.
- The shared `Markdown` renderer from PR #24 sizes its headings, code blocks,
  inline code and tables relative to the surrounding text, so formatted
  replies follow the chat font size. The session log preview keeps its
  current size by setting its own base size around the renderer.
- The chat composer, the approval and question cards, and the chat header
  follow the chat font size. The composer stays at 16px or larger on touch
  devices so iOS doesn't zoom on focus.
- Out of scope:
  - terminal font settings
  - the rest of the app chrome (navigator, settings modal, terminal header)
  - the Debug panel's protocol frames, which stay a fixed-size monospace
    view
  - font family and line-height settings for chat
  - the `@tailwindcss/typography` plugin (PR #24 decided against it)

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`:
  - Adds a requirement that chat text has a readable default size and can be
    adjusted from Settings.
  - Modifies "Assistant markdown renders with visible formatting" (added by
    PR #24). Its "same styling" scenario becomes "same elements and
    proportions", because chat markdown now scales with the chat font size
    and the session preview does not.

## Impact

- Client styles: `src/client/styles/index.css` (chat base size variable and
  secondary size), and possibly `tailwind.config.js` for em-based chat size
  utilities.
- Chat components: `ChatView.tsx`, `ChatMessages.tsx`, `ChatRequests.tsx`.
- Shared renderer: `src/client/components/Markdown.tsx`, and
  `SessionPreviewContent.tsx` so the preview keeps its size.
- Settings: `src/client/stores/settingsStore.ts` (new `chatFontSize` with
  clamping on set and on hydrate) and `SettingsModal.tsx` (new control).
- Tests: settings store and modal tests, chat component tests, and Markdown
  tests.
- No server, protocol or dependency changes.
- Sequencing: PR #24 has merged and this branch is rebased onto `master`,
  which includes the Dark Dimmed palette (PR #23).
