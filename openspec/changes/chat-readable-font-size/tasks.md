# Tasks

## 0. Base

- [ ] 0.1 Once PR #24 (`fix-chat-markdown-rendering`) has merged, rebase `docs/chat-readable-font-size` onto `master` (picking up the Dark Dimmed palette) and verify `bun run test` passes before any code change

## 1. Chat font size setting

- [ ] 1.1 Add `chatFontSize` (default 15) and `setChatFontSize` (clamps to 12–20, rounds to an integer) to `settingsStore.ts` beside `fontSize`. Sanitize the value in the persist `merge`: non-finite falls back to 15, anything else is clamped (design D4). Verify with `settingsStore.test.ts` cases for the default, setter clamping at 11 and 21, a hydrated `"abc"` falling back to 15, a hydrated 40 clamping to 20, and persisted state without the key keeping 15
- [ ] 1.2 Add a "Chat font size" −/+ stepper to `SettingsModal.tsx` in the draft-and-save flow, with the hint "Chat text size in pixels (12-20)". Change the terminal hint so it clearly names the terminal (design D5). Verify with `settingsModal.test.ts` cases: the stepper stops at 12 and 20, Cancel discards the draft, and Save writes `chatFontSize` without changing `fontSize`

## 2. Chat-scoped sizing

- [ ] 2.1 Add `chat-body` (`1em`, line height 1.6) and `chat-meta` (`0.8em`, line height 1.4) under `theme.extend.fontSize` in `tailwind.config.js`. Add `.chat-root { font-size: var(--chat-font-size, 15px) }` and the coarse-pointer `.chat-composer` minimum of 16px to `index.css` (design D1, D2, D6). Verify `bun run build` emits `text-chat-body` and `text-chat-meta`
- [ ] 2.2 In `ChatView.tsx`, give `<main>` the `chat-root` class and set `--chat-font-size` from `chatFontSize`. Replace `text-sm` with `text-chat-body` and `text-xs` with `text-chat-meta` in the header, error, archived banner and composer. The composer gets `chat-composer`. Leave `ChatDebugPanel` unchanged (design D7). Verify with `chatComponents.test.tsx`: the root carries `--chat-font-size: 18px` when the store holds 18, and the composer has the chat classes
- [ ] 2.3 Make the same swap in `ChatMessages.tsx` and `ChatRequests.tsx`, putting size classes only on leaf text containers so `em` sizes don't compound. Verify with `chatComponents.test.tsx`: no `text-sm` or `text-xs` remains on transcript and request elements

## 3. Markdown inherits its size

- [ ] 3.1 In `Markdown.tsx`, drop `text-sm` and `leading-6` from the wrapper and `li`. Use `leading-[1.6]` and the em element sizes from design D3 (`h1` 1.25em, `h2` 1.125em, `h3`–`h6` 1em, `pre` and `table` 0.9em). Update the header comment. Verify `Markdown.test.tsx` still passes, with any class assertions updated to the em sizes
- [ ] 3.2 Wrap `<Markdown>` in `SessionPreviewContent.tsx` with `text-sm leading-6`, so the preview keeps today's size. Verify with a test that the preview wrapper has these classes
- [ ] 3.3 Update the `Markdown` and chat entries in `AGENTS.md` if they describe sizing, and verify the wording matches the code

## 4. Integration check

- [ ] 4.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 4.2 With `bun run dev` and the dev-browser skill, open a chat session with the markdown showcase fixture. Check the computed font sizes: at default settings, the message body is 15px and the "You"/"Claude" labels and turn footer are 12px. Set 18 in Settings: the body becomes 18px, headings are larger than the body, and the terminal font size is unchanged. Open the session log preview and confirm its markdown is still 11.375px. Take before and after screenshots
- [ ] 4.3 Emulate a touch device (coarse pointer) with the chat font size at 13, and check that the composer's computed font size is 16px

## Workflow follow-up

- Archive the change and sync the `chat-sessions` spec after review.
