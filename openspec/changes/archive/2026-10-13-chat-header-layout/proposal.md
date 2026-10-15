# Proposal

## Why

The chat view header (`ChatView.tsx`) has grown one button per feature: Debug, Mailbox, Tasks, Messages, Strategy, Auto-approve, Archive, and Kill session sit in one flat row beside the session status, model, and context meter, all styled alike. At 1440 px the session name truncates to a few characters and the profile wraps; at 1100 px the name disappears and Auto-approve, Archive, and Kill are pushed off-screen, because the row neither wraps nor overflows. Kill — which permanently removes the chat — sits next to Archive with the same styling and, unlike the terminal view, asks for no confirmation. Each new side panel makes the row worse.

## What Changes

- **Two-line identity block.** Line one: a status indicator (colored dot plus the status word) and the session name, still click-to-rename; the redundant ` · Chat` suffix goes. Line two: profile · model · project name (the path's last segment, full path on hover), with the task link and the paused notice as inline chips instead of extra lines. The model moves out of its own column into this line.
- **One panel switcher.** Tasks, Mailbox, Messages, and Strategy become a single segmented control that shows which side-slot panel is open, making the existing one-at-a-time rule visible. Selecting the open panel closes it, as the toggles do today.
- **Auto-approve as a labelled switch.** It stays visible at every width, amber while on, because it changes what the agent may do without asking.
- **Session menu (⋯).** Rename, Debug, Archive, and Kill session move into one menu. Kill is styled as destructive and asks for confirmation, naming the session and saying the removal is permanent; Archive keeps its existing confirm-during-a-turn rule.
- **Width-driven compaction.** As the header narrows, the panel switcher drops to icons (accessible names kept), then folds into the session menu, and the context meter shortens to its percentage; no control is ever clipped or pushed off-screen. Steps follow the header's own width, not the viewport's, since the navigator takes part of the window.
- **One source for the open panel.** The header reads which panel is open from one derived value and opens panels through one function, so adding a panel is a one-entry change.

**Non-goals:**
- Count badges on panel tabs (held mail, blocked tasks) — a follow-up once the panels expose counts.
- Merging Messages into Mailbox: `team-message-threads` keeps them separate on purpose (history vs. delivery operations).
- The `[mod]+X` kill shortcut and the terminal view's header are unchanged.
- No server, protocol, or stored-state change.

## Capabilities

### New Capabilities

- `chat-header`: the chat view header's layout and controls — identity and status block, side-panel switcher, approval switch, session menu with confirmed kill, and width-driven compaction.

### Modified Capabilities

None. Existing requirements that place controls "in the chat view header" (rename, archive, approval switch, Debug toggle, context meter, model) still hold: each control stays reachable from the header, some through its menu.

## Impact

- Client only: new `src/client/components/chat/ChatHeader.tsx` (extracted from `ChatView.tsx`, now 485 lines), `ChatSessionMenu.tsx` (Base UI `Menu`), `ChatPanelSwitcher.tsx`, a kill-confirmation dialog, and a header-width hook; `sideSlot.ts` gains the derived open-panel value and a single toggle; `ChatContextMeter.tsx` gains a compact form; `Switch.tsx` reused.
- Dependencies already present: `@base-ui/react` (Menu, Dialog), `@untitledui-icons/react` (tab icons).
- Tests: `chatComponents.test.tsx`, `claudeProfileUi.test.tsx`, and the e2e specs that click header buttons (`chat.spec.ts`, `chat-auto-approve.spec.ts`, `chat-teams.spec.ts`, `chat-team-messages.spec.ts`, `strategy.spec.ts`, and others) move to the new roles and menu paths; existing `data-testid`s are kept.
