## Why

The workspace navigator renders every section — change sections, worktree sections, `Workspace`, and `Remote` — as one continuous scroll column, so the sections a user cares about least push the ones they watch constantly off-screen. Remote sessions are the clearest case: they sit last, their height is dictated by however many rows happen to exist, and there is no way to give them a fixed, predictable slice of the sidebar. The two fallback sections are also the only sections in the navigator that cannot be collapsed at all.

## What Changes

- `Workspace` and `Remote` become **docked panes** at the bottom of the sidebar: each has a fixed height, its own internal scroll, and a drag handle on its top edge. Change and worktree sections keep flowing and scrolling together in the region above them.
- `Remote` defaults to **25% of the sidebar height**; `Workspace` defaults to 25% as well (see Assumptions). Panes shrink proportionally when the sidebar is too short to honor both defaults, and the flowing region above always keeps a minimum height.
- Pane heights are **resizable by dragging** the handle above a pane, and by keyboard once the handle is focused. Sizes are stored as fractions of the sidebar height and persist across reloads.
- `Workspace` and `Remote` headers become **collapsible**, matching change/worktree section headers (chevron, `aria-expanded`, count). A collapsed pane keeps only its header row and **redistributes its freed height** to the remaining expanded panes; re-expanding restores its previous size.
- The **mobile drawer uses the same panes and the same persisted fractions**, so a size set on the desktop sidebar is the size seen in the drawer.
- Not changing: section ordering, row rendering, filters, drag-to-reorder, keyboard session navigation, or the flat (pre-snapshot) list used when no workspace snapshot exists.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workspace-navigation`: adds a requirement for resizable, independently scrolling `Workspace` and `Remote` panes with persisted sizes, and extends section collapse to cover those two fallback sections.

## Impact

- `src/client/components/WorkspaceSectionList.tsx` — fallback sections become collapsible panes; new layout container and resize handles.
- `src/client/components/SessionList.tsx` — the single scroll container splits into a scrolling flow region plus docked panes.
- `src/client/components/SectionHeader.tsx` (or a shared header primitive) — the collapse control is reused by the fallback headers.
- `src/client/stores/settingsStore.ts` — persisted pane fractions alongside `sidebarWidth` (persist `version` bump).
- `src/client/stores/workspaceStore.ts` — reserved collapse keys for the two fallback sections.
- `src/client/utils/workspaceView.ts` — fallback sections gain a `collapsed` flag and contribute `hiddenAttentionCount` when collapsed; `visibleEntries` excludes rows hidden by a collapsed fallback pane.
- `src/client/components/SessionDrawer.tsx` — inherits the panes through `SessionList`; verifies the drawer's own height model still works.
- Tests: `workspaceView.test.ts`, `sessionListGrouped.test.tsx`, `SectionHeader.test.tsx`, `settingsStore.test.ts`, `workspaceStore.test.ts`, `sessionDrawer.test.tsx`, plus an e2e pass on sidebar layout.
- No server, protocol, or shared-type changes.

## Assumptions

- "Bottom 25% of the screen" is read as 25% of the **sidebar's** height (the sidebar is already full-height), measured below the sticky filter bar.
- `Workspace` defaults to the same 25% fraction for symmetry; the user only specified `Remote`.
- A pane that has no entries is not rendered at all and reserves no space — unchanged from today.
