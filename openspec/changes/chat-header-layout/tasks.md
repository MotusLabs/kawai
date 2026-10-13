# Tasks

## 1. One source for the open side panel

- [ ] 1.1 In `src/client/components/chat/sideSlot.ts`, add `useOpenSideSlot(sessionId)` and `toggleSideSlot(which, sessionId)` over a `SideSlot → { open, close }` table (design D2), and update the header comment. Verify with unit tests: toggling each slot opens it and closes the others; toggling the open slot closes it; `useOpenSideSlot` returns `null` when nothing is open and the open slot after `openTasks(taskId)`-style opens.
- [ ] 1.2 Replace the five hand-written toggles in `ChatView.tsx` with `toggleSideSlot`, keeping `openTasks(taskId)` and `openThread` as they are. Verify: `bun run test` passes with no change to the existing ChatView and teamMessagesHost tests.

## 2. Extract the header

- [ ] 2.1 Move the header JSX and rename state into `src/client/components/chat/ChatHeader.tsx`, with props per design D1, leaving subscription effects in `ChatView`. Behavior is unchanged in this step. Update both files' header comments. Verify: `ChatView.tsx` is under 450 lines, and `bun run lint && bun run typecheck && bun run test` passes unchanged.

## 3. Identity and status block

- [ ] 3.1 Extract the `statusDot` map from `TerminalControls.tsx` into `src/client/utils/sessionStatus.ts` (with the connection and archived mappings, design D7) and import it in both places. Verify with a unit test for each status, connection state, and archived.
- [ ] 3.2 Render the two-line identity block: status dot and word plus name (no ` · Chat`) on line one; profile · model · project name, with full values in titles, and the task and paused chips on line two; existing test ids kept. Verify with component tests for the spec's "Live session identity", "Status indicator follows the session", "Task and paused chips", and "Rename from the name" scenarios, then update the e2e assertions that expect `· Chat`, `Profile: …`, or a separate model column (`grep -rn "· Chat\|Profile:" tests/e2e`).

## 4. Panel switcher and approval switch

- [ ] 4.1 Add `ChatPanelSwitcher.tsx`: a `role="group"` of `aria-pressed` buttons for Tasks, Mailbox, Messages, and Strategy, with labelled and icon-only forms (design D3), wired to `toggleSideSlot` and `useOpenSideSlot`. Debug leaves the row. Verify with component tests for the "Opening a panel selects it", "Choosing the open panel closes it", "Panel opened from the task chip", and "Icon-only entries keep their names" scenarios.
- [ ] 4.2 Replace the Auto-approve button with a labelled `Switch` (design D9), hidden for archived chats. Verify with component tests for "Switch reflects the policy" and "Archived chat has no switch", then update the header locators in `chat-auto-approve.spec.ts` (and any other hits of `grep -rln "chat-approval-policy" tests/e2e src/client/__tests__`) from button to switch.
- [ ] 4.3 Update the e2e specs that open panels by button name (`chat-teams.spec.ts`, `chat-team-messages.spec.ts`, `strategy.spec.ts`, and any others `grep -rln "name: '\(Tasks\|Mailbox\|Messages\|Strategy\)'" tests/e2e` finds) and the CLAUDE.md bullets that describe the header buttons and side slot. Verify the fixture e2e specs with `bunx playwright test <spec>` against an isolated server; never `test:e2e` while the user's kawai is live.

## 5. Session menu and kill confirmation

- [ ] 5.1 Add `ChatSessionMenu.tsx` on Base UI `Menu` (design D4): Rename, Debug as a checkbox item, a separator, Archive (live only), and Kill session (danger, last), keeping `chat-archive-button`. Verify with component tests for "Menu actions for a live chat", "Debug from the menu", "Menu for an archived chat", and "Keyboard through the session menu".
- [ ] 5.2 Add `ChatKillDialog.tsx` on Base UI `AlertDialog` (design D5), with Cancel focused first; Kill session opens it and only Kill calls `onKill`. Verify with component tests for "Confirmed kill" and "Cancelled kill" (both Cancel and Escape).
- [ ] 5.3 Update the e2e specs and unit tests that click Debug, Archive, or Kill session directly (`chat.spec.ts`, `chat-real.spec.ts`, `chat-drafts.spec.ts`, `chat-workers.spec.ts`, `chat-activity.spec.ts`, `chat-external-cli.spec.ts`, `chatComponents.test.tsx`, `claudeProfileUi.test.tsx`; re-grep before editing) to go through the menu, and confirm the kill. Update the CLAUDE.md archive and Debug wording. Verify the touched fixture e2e specs pass in isolation.

## 6. Width-driven layouts

- [ ] 6.1 Add `useHeaderLayout(ref, fontSizePx)` (design D6) with `FULL_MIN_EM`/`ICONS_MIN_EM`, returning `'full'` without `ResizeObserver`, plus an optional `layout` prop on `ChatHeader`. Verify with unit tests on a stubbed `ResizeObserver`: each threshold side, the font-size scaling, and observer cleanup on unmount.
- [ ] 6.2 Render the three layouts: labelled switcher; icons; and panel entries folded into the session menu with the compact context meter (`ChatContextMeter compact`, design D8). Verify with component tests for "Full layout on a wide header", "Icons on a medium header", "Switcher folds into the menu", and "Switch survives narrow headers".
- [ ] 6.3 Tune the threshold constants from Playwright screenshots of a chat header at 1920/1440/1100/768 px windows, at the smallest and largest chat font sizes, and with the navigator widened ("Same window, narrower header"). Check that no control is clipped or outside the header and that the name keeps visible characters. Use an isolated server and attach only to an archived or already-live session. Verify: the screenshots are attached to the PR description.

## 7. Final verification

- [ ] 7.1 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate chat-header-layout --strict`; all pass.

## Workflow follow-up

- Archive with `/openspec-archive-change chat-header-layout` after merge, which creates `openspec/specs/chat-header/spec.md`.
