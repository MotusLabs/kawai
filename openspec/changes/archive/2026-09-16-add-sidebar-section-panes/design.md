## Context

See `proposal.md` — Why. Current state that shapes the approach:

- `SessionList.tsx:497` wraps the filter bar and the entire navigator in one `div.min-h-0.flex-1.overflow-y-auto`; the filter bar is `sticky top-0` inside it. Every section flows in that single scroll box.
- `WorkspaceSectionList.tsx` renders change/worktree sections via `SectionHeader` (collapse lives in `workspaceStore.collapsedSectionIds`, persisted under `agentboard-workspace`) and renders `Workspace`/`Remote` through a local `FallbackSectionHeader` that has no collapse control at all.
- `workspaceView.ts` models fallback sections as `FallbackSectionData` — `kind`, `entries`, `attentionCount`, `hiddenAttentionCount` — with no `collapsed` flag, and `visibleEntries` (the keyboard/terminal navigation order) already excludes rows inside collapsed sections.
- The sidebar column in `App.tsx:1155` has a definite height (`h-full`), and the mobile drawer (`.session-drawer`, `styles/index.css:475`) is a fixed `top:0;bottom:0` flex column — so the navigator's height is definite in both hosts. Sidebar *width* is already a persisted preference (`settingsStore.sidebarWidth`, clamped 180–400) resized by a `mousedown` handle in `App.tsx:160`.
- `settingsStore` persists its whole state (no `partialize`) at `version: 7`.

## Goals / Non-Goals

**Goals:**

- One layout mechanism that produces the sizing behavior in `specs/workspace-navigation/spec.md` in both the desktop sidebar and the mobile drawer, without measuring layout on every render.
- Collapse for `Workspace`/`Remote` that reuses the existing section-collapse storage and header semantics rather than adding a parallel mechanism.
- A resize control that is usable by pointer, touch, and keyboard.

**Non-Goals:**

- Changing the existing horizontal sidebar-width handle in `App.tsx` (different axis, different store field, no user-visible problem to fix).
- Making change/worktree sections resizable — they keep flowing in the scroll region above (see the answered scope question in `proposal.md`).
- Server-side persistence or cross-device sync of pane sizes; sizes stay in local storage like every other layout preference.

## Decisions

### Flex column with percentage bases, not measured pixel heights

The navigator body becomes a flex column: filter bar (`shrink-0`, no longer `sticky` since it leaves the scroll box), then the flow region for change/worktree sections (`flex: 1 1 0; min-height: <flow min>; overflow-y: auto`), then the `Workspace` pane, then the `Remote` pane. Each pane is `flex: 0 1 <fraction*100>%` with its own `overflow-y: auto`.

Why: percentage flex-basis resolves against the container's definite height, so the "25% of the navigator" requirement is expressed directly in CSS and survives window resize, sidebar-width change, and drawer open with no `ResizeObserver` and no re-render. Flex shrink is weighted by basis, so when space runs short the panes shrink *proportionally* on their own — exactly the spec's degenerate-case behavior — while the flow region's `min-height` and each pane's `min-height` (its header row) hold the floors.

Alternative rejected: measure the container with a `ResizeObserver` and set pixel heights. It re-renders on every resize frame, needs a measurement before first paint (panes would flash at the wrong size), and would have to re-implement proportional shrinking by hand.

Pixel measurement is still needed *during a drag*, but only there: on `pointerdown` the handle reads the container's `getBoundingClientRect().height` once and converts pointer delta to a fraction against it.

### Collapse redistributes implicitly

A collapsed pane switches to `flex: 0 0 auto` and renders only its header, so its percentage disappears from the layout. The remaining expanded pane keeps its own percentage of the container, and the flow region — `flex: 1 1 0` — absorbs everything left over. That is the "space redistributed" behavior without any bookkeeping, and because the stored fraction is never touched by collapsing, re-expanding restores the previous size for free.

### Fractions in `settingsStore`, collapse in `workspaceStore`

Sizes: `workspacePaneFraction` and `remotePaneFraction` (default `0.25`) in `settingsStore`, next to `sidebarWidth`, clamped by their setters to `[PANE_MIN_FRACTION, PANE_MAX_FRACTION]` = `[0.1, 0.6]` — the same shape as `setSidebarWidth`. No `version` bump: the store has no `partialize`, so zustand's shallow default merge already supplies the new keys to state persisted at v7. Rehydrated values are re-clamped on read so a hand-edited or corrupt value cannot produce an unusable layout.

Collapse: reuse `workspaceStore.toggleSectionCollapsed` / `isSectionCollapsed` with the reserved keys `fallback::workspace` and `fallback::remote`, exported as constants from `shared/workspace.ts` beside `changeSectionKey`. Change keys are `<repositoryId>::change::<name>` and worktree keys are canonical-path-derived worktree ids, so neither can produce the reserved strings; a unit test pins that.

Why split across two stores: each new field sits with its existing analogue — collapse state is already section-collapse state in `workspaceStore` (and inherits its persistence and its "stable section identity" contract), while pane sizing is a layout preference like `sidebarWidth`. Alternative rejected: moving everything into one store, which would either fork fallback collapse away from section collapse or move a layout preference out of `settingsStore` for no benefit.

### `PaneResizeHandle` on pointer events, `role="separator"`

A shared component rendered on each expanded pane's top edge:

- `role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow/valuemin/valuemax` as whole percents, `aria-label` naming the pane, `tabIndex={0}`.
- Pointer events (`pointerdown` + `setPointerCapture`) rather than the `mousedown`/`document` listeners used by the width handle: one code path covers mouse and touch, capture ends the drag cleanly if the pointer leaves the sidebar, and `touch-action: none` on the handle keeps a drag from scrolling the drawer underneath.
- Keyboard: `ArrowUp`/`ArrowDown` step the fraction by `0.02`, `Home`/`End` jump to min/max. Steps go through the same clamped store setter as dragging.
- Dragging the `Workspace` handle changes only `workspacePaneFraction`; the `Remote` handle changes only `remotePaneFraction`. Because the flow region is the flexible one, the region above always absorbs the delta — no paired "the neighbor gives up what I take" arithmetic.

### View-model change

`FallbackSectionData` gains `collapsed: boolean`. `buildWorkspaceView` reads the two reserved keys, and — mirroring what it already does for change/worktree sections — moves a collapsed fallback section's attention into `hiddenAttentionCount` and drops its rows from `visibleEntries`, so keyboard navigation skips rows hidden inside a collapsed pane. Keeping this in the pure selector means the behavior is unit-testable without rendering.

`FallbackSectionHeader` in `WorkspaceSectionList.tsx` is replaced by a header that reuses `SectionHeader`'s collapse trigger, so both header families share chevron, `aria-expanded`, and count markup.

### Testing approach

jsdom has no layout, so unit tests assert the *inputs* to layout — the flex basis / collapsed attributes rendered per pane, store transitions, clamping, and view-model `visibleEntries` / `hiddenAttentionCount` — plus keyboard resize through synthetic key events and drag through synthetic pointer events with a stubbed `getBoundingClientRect`. The actual "bottom 25%" pixel share, independent scrolling, and touch drag are covered by a Playwright e2e case in `tests/e2e`, which is where real layout exists.

## Risks / Trade-offs

- **Removing `sticky` from the filter bar changes its stacking context** → It becomes a normal `shrink-0` flex row above the scroll region; its `z-10` and background stay so open filter dropdowns still paint over rows. Covered by the existing `sessionListFilters` tests plus an e2e check that a dropdown opens over the list.
- **Short viewports (mobile landscape) can't honor two 25% panes plus the flow minimum** → Proportional shrink handles it down to the header floors; below that the navigator body scrolls as a whole rather than clipping headers. Spec'd and e2e-checked at a small viewport.
- **A pane drag on touch could fight the drawer's scroll or edge-swipe** → `touch-action: none` and pointer capture confine the gesture to the handle, which is a thin, deliberate target; the rest of the pane scrolls normally.
- **Two panes at their maximum (0.6 + 0.6) would starve the flow region** → The flow region's `min-height` wins because it is a minimum against shrink; the panes shrink proportionally instead. A per-pane max alone can't express the joint constraint, which is why the floor lives on the flow region rather than as arithmetic in the setters.
- **Sharing fractions with the mobile drawer means one number serves two very different heights** → It is a *fraction*, so it degrades sensibly; the alternative (separate desktop/mobile values) was rejected against the answered scope question asking for shared sizes.

## Migration Plan

Client-only, no server or protocol change. Persisted settings at `version: 7` gain the two new keys by default merge, so an existing install opens with `Remote` at 25% and nothing to migrate; stale `collapsedSectionIds` entries are unaffected. Rollback is a straight revert — the two orphaned settings keys are ignored by the previous build.
