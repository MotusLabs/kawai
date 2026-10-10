# Tasks

## 1. Settings tab shell

- [x] 1.1 Add tab state and a nav strip (Sessions / Chat / Terminal / General) to `SettingsModal.tsx`, wrap the existing sections in four panels, and mark the three inactive panels `hidden` so they leave the accessibility tree — verify `bun run test src/client/__tests__/settingsModal.test.tsx` passes unchanged, since every control stays mounted
- [x] 1.2 Move each existing section to its tab (Dark Mode and Notifications and the shortcut modifier to General; chat font size and `ChatProviderSettings` to Chat; everything else to Sessions or Terminal as in design D4) — verify `bun run test src/client/__tests__/settingsModal.test.tsx` passes and the modal still opens on Sessions

## 2. Extract section components

- [x] 2.1 Extract the Sessions tab into `src/client/components/settings/SessionsSettings.tsx`, keeping drafts in the shell and moving only the section's own ephemeral state (add-preset form) — verify the file is under 500 lines, `bun run typecheck` passes, and `settingsModal.test.tsx` passes
- [x] 2.2 Extract the Chat tab into `src/client/components/settings/ChatSettings.tsx` as a thin composition of `FontSizeStepper` and `ChatProviderSettings` — verify the file is under 500 lines and `settingsModal.test.tsx` plus `bun run test src/client/__tests__/chatProviderSettings.test.tsx` pass
- [x] 2.3 Extract the Terminal tab into `src/client/components/settings/TerminalSettings.tsx`, moving the four self-saving settings (mouse mode, terminal colors, history lookback, window names) with their immediate-PUT handlers (design D5) — verify the file is under 500 lines and the terminal-colors loading and update tests in `settingsModal.test.tsx` pass
- [x] 2.4 Extract the General tab into `src/client/components/settings/GeneralSettings.tsx` (theme, notifications, shortcut modifier) — verify the file is under 500 lines and `settingsModal.test.tsx` passes

## 3. Default approval policy store and Settings control

- [x] 3.1 Add `defaultApprovalPolicy: ChatApprovalPolicy` with setter to `useSettingsStore`, defaulting to `'manual'` and re-sanitized on persist merge so any value other than `'auto'` reads as `'manual'` (design D1) — verify `bun run test src/client/__tests__/settingsStore.test.ts` covers the default, a saved `'auto'`, and rejection of a corrupt value
- [x] 3.2 Add the segmented `[ Manual | Auto-approve ]` control to the Chat tab, drafted from the store and committed on Save like `defaultPresetId` (design D7) — verify `settingsModal.test.tsx` covers Save committing the value and Cancel discarding it
- [x] 3.3 Update the approval-policy note in `CLAUDE.md` to say new chat sessions start with the Settings default rather than always manual — verify the note matches the behavior in 3.1 and 4.2

## 4. Create-time policy on the wire and server

- [x] 4.1 Add optional `approvalPolicy?: ChatApprovalPolicy` to the `session-create` message in `src/shared/types.ts` and thread it through `handleCreateSession` in `src/client/App.tsx` — verify `bun run typecheck` passes and no existing `session-create` call site changes shape
- [x] 4.2 Let `ChatSessionManager.createSession` accept `approvalPolicy` and use it instead of hardcoding `'manual'`, falling back to `'manual'` when absent — verify `bun run test src/server/__tests__/chatSessionManager.test.ts` covers created-with-auto, created-without-policy, and that a named profile leaves the supplied policy unchanged
- [ ] 4.3 Pass `approvalPolicy` from the `session-create` handler in `src/server/index.ts` into `createAvailableSession` — verify `bun run test src/server/__tests__/` covers the chat create path and an absent field still producing a manual session

## 5. New Session dialog override

- [ ] 5.1 Add an "Auto-approve tools" checkbox to `NewSessionModal` shown only when `kind === 'chat'`, pre-checked from `defaultApprovalPolicy`, and passed through `onCreate` (design D2) — verify `bun run test src/client/__tests__/newSessionModal.test.tsx` covers the checkbox appearing for chat and not for terminal
- [ ] 5.2 Cover seeding and override in `newSessionModal.test.tsx`: the default of auto pre-checks the box, unchecking it creates a manual session, and the default of manual leaves it unchecked — verify those three cases pass

## 6. Integration verification

- [ ] 6.1 Run `bun run lint && bun run typecheck && bun run test` and verify the full suite is green with no new failures
- [ ] 6.2 Open Settings and step through all four tabs in the running app (dev-browser), verify the Chat tab shows the approval control beside chat font size and provider env, and verify a chat session created with the box unchecked starts manual — confirm by the header toggle state and by the absence of auto-approval cards on its first tool use

## Workflow follow-up

- Archive the change once review requirements are satisfied.
- Verify the archived result: the two amended requirements appear in `openspec/specs/chat-sessions/spec.md` and `openspec/specs/claude-session-profiles/spec.md`.
