# Tasks

## 1. Palette tokens

- [x] 1.1 In `src/client/styles/index.css`, add `--chat-danger`, `--chat-wire-out`, `--chat-wire-in` and `--chat-wire-stderr` to the dark-default and light rules, using today's Tailwind values (`red-400`, `sky-400`, `emerald-400` and `amber-400`). Expose them in `tailwind.config.js` as `chat-danger`, `chat-wire-out`, `chat-wire-in` and `chat-wire-stderr`. Verify with `bun run build`.
- [x] 1.2 Add the `:root:not([data-theme="light"]) .chat-palette` rule with the Primer Dark Dimmed values from design.md decision 2, including the status tokens. Add the scoped `.chat-palette .btn-primary` background and hover rules (`#316dca`/`#2a5fb3`). Verify with `bun run build`.
- [x] 1.3 Add `src/client/__tests__/chatPalette.test.ts`. It parses `index.css` and asserts the WCAG contrast bounds from design.md decision 5: primary on base between 7:1 and 10:1; secondary on base and elevated ≥4.5; danger and the wire colors on base ≥4.5; white on the primary button and on its hover ≥4.5. It also asserts that the light rule doesn't contain the scope. Verify with `bun test src/client/__tests__/chatPalette.test.ts`.

## 2. Chat components adopt the scope

- [x] 2.1 Add `chat-palette` to `ChatView`'s root `<main>`. Replace `text-red-400` with `text-chat-danger` in the `ChatView` error banner and in `ChatMessages`' error event. Update `ChatView.tsx`'s header comment. Verify with a `chatComponents.test.tsx` case asserting that the root class and the danger class are present and `red-400` is absent.
- [x] 2.2 In `ChatDebugPanel.tsx`, map `DIRECTION_STYLES` to `text-chat-wire-out`, `text-chat-wire-in` and `text-chat-wire-stderr`, keeping `lifecycle` as `text-secondary`. Verify with a `chatComponents.test.tsx` case that renders frames of each direction and asserts the token classes.
- [x] 2.3 Run `bun run lint && bun run typecheck && bun run test` and verify all three pass.

## 3. Visual verification

- [ ] 3.1 With the `dev-browser` skill, start `bun run dev`. Open a chat session in the dark theme with user and assistant messages, a tool entry, an approval card and the Debug panel open. Take a screenshot and confirm that the chat pane uses the dimmed palette and the navigator keeps its near-black colors.
- [ ] 3.2 Switch to the light theme and take a screenshot. Confirm that the chat view looks the same as on `master`.

## Workflow follow-up

- If `fix-chat-markdown-rendering` lands first, re-check the markdown screenshot. Inline code and code blocks should use `--bg-surface`/`--bg-base` from the chat scope.
- Archive the change after review.
