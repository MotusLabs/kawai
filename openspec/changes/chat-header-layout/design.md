# Design

## Context

The header is inline JSX in `ChatView.tsx` (lines 363–402 on master; the file is 485 lines). Each side panel has its own Zustand store with its own `open` shape: `chatDebugStore.beginOpen`, `teamMailboxStore.open`, `teamTaskStore.open(sessionId, taskId?)`, `teamMessageStore.open` (+ `select` for a thread), and `strategyStore.open`. `sideSlot.ts` already centralizes "close the others" (`closeOtherSideSlots`), but `ChatView` still holds five hand-written toggles, and other paths open panels too: the task chip (`openTasks(taskId)`) and task-detail message links (`openThread`). Subscription effects (`*-open`/`*-close` over the WebSocket) are keyed on each store's `open` flag and live in `ChatView`.

Constraints: chat text sizes in em through `--chat-font-size` (Settings "Chat Font Size"), so the room the header's labels need scales with that setting; the Bun test renderer has no `ResizeObserver` and no layout; `@base-ui/react` 1.2 (Switch, Toast in use; Menu, AlertDialog, Tooltip available) and `@untitledui-icons/react` are already dependencies.

## Goals / Non-Goals

**Goals:**
- A header whose control placement is decided in one small component, with the open panel read from one place.
- Width steps that are deterministic and testable without a browser.

**Non-Goals:**
- Changing any panel's store shape, subscription protocol, or panel contents.
- A generic toolbar-overflow framework; the three layouts are fixed.

## Decisions

### D1. Extract `ChatHeader` and keep effects in `ChatView`

`ChatHeader.tsx` renders the header from props: `session`, `transcript` facts (model, context usage), `connectionStatus`, the open slot, and callbacks (`onToggleSlot`, `onOpenTask`, `onRename`, `onToggleApproval`, `onArchive`, `onKill`, `onClose`). The WebSocket subscription effects stay in `ChatView`, since they belong to the view's attach lifecycle rather than to the header. This also brings `ChatView` back well under 500 lines.

*Alternative:* move the effects into each panel. That would be cleaner long term, but it changes the reconnect behavior the specs pin, so it is out of scope.

### D2. Derive the open slot; toggle through one table

`sideSlot.ts` gains `useOpenSideSlot(sessionId): SideSlot | null`, which reads the five stores' `open` flags (at most one is true, by construction), and `toggleSideSlot(which, sessionId)`, which closes the others and then opens or closes `which` through a `SideSlot → { open, close }` table wrapping each store's own call. `openTasks(taskId)` and `openThread` keep their extra arguments but call `closeOtherSideSlots` as today. Adding a panel then means one table entry and one switcher entry.

*Alternative:* one new store owning `openSlot`. Rejected: each store's `open` carries panel state (a selected task, debug paging), so a single store would duplicate or migrate that state for no visible gain.

### D3. Switcher = pressed-button group, not tabs

Tasks, Mailbox, Messages, and Strategy render as `role="group"` (`aria-label="Side panels"`) of buttons with `aria-pressed`, joined visually as a segmented control. "Nothing open" is a valid state, which `tablist` cannot express without a phantom tab, and pressed buttons match today's toggles, so existing `getByRole('button', { name })` lookups keep working. Order: Tasks, Mailbox, Messages, Strategy. Icons come from `@untitledui-icons/react` (line set). Debug is not in the group (D4).

### D4. Session menu on Base UI `Menu`

A `⋯` trigger (`aria-label="Session actions"`) opens `ChatSessionMenu`: Rename, Debug (`Menu.CheckboxItem`, checked while open), a separator, Archive (live only), and Kill session (danger style, last). In the narrowest layout, the four panel entries come first as `CheckboxItem`s. Base UI provides roving focus, typeahead, Escape, and focus return. The hand-rolled `SessionRow` context menu is not reused because it is pointer-positioned and has no keyboard model. Rename calls the same `setEditingName(true)` the name click uses. Existing test ids stay on the menu items (`chat-archive-button`, and so on).

### D5. Kill confirmation on Base UI `AlertDialog`

`ChatKillDialog`: the title is "Kill session", and the body reads `Kill “<name>”? This permanently removes the chat session from kawai. Archive keeps it instead.` Actions are Cancel and Kill (`btn-danger`). Initial focus goes to **Cancel**, because a chat kill is irreversible. The terminal modal focuses Kill instead; that is acceptable since its process-only kill leaves logs. Confirming calls the existing `onKill`, so App's `handleKillSession` path (rollback on `kill-failed`) is unchanged. The `[mod]+X` shortcut is not routed through the dialog (proposal non-goal).

### D6. Layout from the header's width in chat-font ems

`useHeaderLayout(ref, fontSizePx)` observes the header with `ResizeObserver` and returns `'full' | 'icons' | 'menu'` from `width / fontSizePx` against two constants: `FULL_MIN_EM` and `ICONS_MIN_EM`, starting at about 78 em and 54 em. Those starting values come from today's 13 px header (≈1000 px fits every labelled control, ≈700 px fits icons) and get tuned against screenshots in task 6.3. Measuring in ems keeps the steps right when the user changes the chat font size. Because the header's width is set by its container rather than its content, switching layouts cannot feed back into the width, so no hysteresis is needed. Without `ResizeObserver` (test renderer) the hook returns `'full'`, and tests drive the other layouts through an optional `layout` prop on `ChatHeader`.

*Alternative:* CSS container queries. Rejected: folding the switcher into the menu changes the DOM, so CSS would need hidden duplicate controls, which means duplicate test ids and accessible names, and the Bun renderer could not test them.

### D7. Identity block details

- **Status dot:** reuse the `statusDot` color map from `TerminalControls.tsx` (`bg-working`, `bg-waiting`, `bg-approval`, `bg-muted`), extracted to `src/client/utils/sessionStatus.ts` and imported by both. Archived uses `bg-muted`. Connection states map as in `Header.tsx`. The word stays next to the dot, so color is never the only signal, and `data-testid="chat-status"` stays on the word.
- **Second line:** `Default · claude-opus-5-5 · kawai`, `·`-separated, truncating from the end, with each segment's full value as its `title`. The project name is the last non-empty segment of `projectPath`. `chat-profile` and `chat-model` test ids stay on their segments, and the profile segment's title is `Profile: <label>`.
- **Chips:** the task chip (`chat-task`) and the paused chip (`chat-paused`) follow on the same line. Paused keeps its amber text.

### D8. Compact context meter

`ChatContextMeter` gains `compact?: boolean`. When compact it renders `4.9%` (plus `~` when the threshold is approximate), and its existing title already carries the counts. It is used in the `'menu'` layout only.

### D9. Approval switch

The existing `Switch.tsx` (Base UI) with a visible "Auto-approve" label replaces the toggle button. The on state reuses the amber of `btn-approval-on`. Avoid `bg-…/NN` opacity utilities: the Tailwind var colors emit none. `data-testid="chat-approval-policy"` moves to the switch root, and its role changes from `button` to `switch` (tests updated in task 4.2).

## Risks / Trade-offs

- [Debug, Archive, and Kill now take two clicks] → They are rare actions. Archive also stays in the navigator row context menu, and the shortcut stays for kill.
- [Threshold constants are estimates] → Task 6.3 tunes them with screenshots at 1920/1440/1100/768 px and at the smallest and largest chat font sizes before merge.
- [Role change on Auto-approve (`button` → `switch`) breaks e2e locators] → All affected specs are listed in tasks and updated in the same change.
- [Base UI Menu and AlertDialog are new to the codebase] → Both ship in the already-pinned `@base-ui/react` 1.2. A unit test covers keyboard open, move, and Escape.
- [`team-message-threads` is still unarchived on master] → This change assumes its Messages toggle as shipped code. If that change is archived first, nothing here conflicts, since neither change's spec pins the header layout.

## Migration Plan

Client-only and stateless, so no migration is needed. Rollback is a revert.
