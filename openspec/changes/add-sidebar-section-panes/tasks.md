## 1. State and view model

- [x] 1.1 Add `FALLBACK_WORKSPACE_SECTION_KEY = 'fallback::workspace'` and `FALLBACK_REMOTE_SECTION_KEY = 'fallback::remote'` to `src/shared/workspace.ts` beside `changeSectionKey`; verify with a unit test asserting neither value can be produced by `changeSectionKey` or by a worktree id.
- [x] 1.2 Add `workspacePaneFraction` and `remotePaneFraction` (default `0.25`) plus clamped setters to `src/client/stores/settingsStore.ts`, with `PANE_MIN_FRACTION = 0.1` / `PANE_MAX_FRACTION = 0.6` exported; verify in `settingsStore.test.ts` that out-of-range values clamp and that state persisted at `version: 7` without the keys rehydrates to the defaults (no version bump).
- [x] 1.3 Add `collapsed: boolean` to `FallbackSectionData` in `src/client/utils/workspaceView.ts` and populate it from the two reserved keys; verify in `workspaceView.test.ts`.
- [x] 1.4 Make a collapsed fallback section move its attention into `hiddenAttentionCount` and drop its rows from `visibleEntries`; verify in `workspaceView.test.ts` that keyboard navigation order skips rows inside a collapsed `Remote` section while its hidden attention count is reported.

## 2. Collapsible fallback headers

- [ ] 2.1 Extract `SectionHeader`'s collapse trigger into a reusable piece (shared chevron, `aria-expanded`, label) without changing existing change/worktree header markup; verify `SectionHeader.test.tsx` still passes unchanged.
- [ ] 2.2 Replace `FallbackSectionHeader` in `WorkspaceSectionList.tsx` with a header using that trigger, wired to `onToggleCollapse` with the reserved key, showing the label, count, and an attention badge; verify in `sessionListGrouped.test.tsx` that clicking the `Remote` header toggles `aria-expanded` and hides its rows.
- [ ] 2.3 Persist fallback collapse through `workspaceStore.toggleSectionCollapsed`; verify in `workspaceStore.test.ts` that a collapsed fallback key round-trips through the persisted `collapsedSectionIds`.

## 3. Pane layout

- [ ] 3.1 Restructure `SessionList.tsx` into a flex column: `shrink-0` filter bar (no longer `sticky`), `flex-1 min-h-0 overflow-y-auto` flow region for change/worktree sections, then the fallback panes; verify `sessionListComponent.test.tsx` and `sessionListFilters.test.tsx` pass and the filter dropdown still renders above the list.
- [ ] 3.2 Render each displayed fallback section as a pane with `flex: 0 1 <fraction*100>%`, its own `overflow-y: auto`, and a `min-height` of its header row; verify in `sessionListGrouped.test.tsx` via the rendered flex basis for the default 25% and for a stored fraction.
- [ ] 3.3 Give the flow region a `min-height` floor so panes shrink proportionally instead of displacing it, and render a collapsed pane as `flex: 0 0 auto` with header only; verify in `sessionListGrouped.test.tsx` that a collapsed pane carries no percentage basis and its stored fraction is unchanged.
- [ ] 3.4 Keep a fallback section with no entries unrendered and reserving no height; verify in `sessionListGrouped.test.tsx`.

## 4. Resize control

- [ ] 4.1 Add `src/client/components/PaneResizeHandle.tsx` with `role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow/valuemin/valuemax` in whole percents, `aria-label`, `tabIndex={0}`, and `touch-action: none`; verify a new `paneResizeHandle.test.tsx` asserts the ARIA contract.
- [ ] 4.2 Implement pointer drag: `pointerdown` captures the pointer and reads the container height once, `pointermove` converts delta to a clamped fraction, `pointerup`/`pointercancel` release capture; verify in `paneResizeHandle.test.tsx` with synthetic pointer events and a stubbed `getBoundingClientRect`.
- [ ] 4.3 Implement keyboard resize: `ArrowUp`/`ArrowDown` step by `0.02`, `Home`/`End` jump to min/max, all through the clamped setters; verify in `paneResizeHandle.test.tsx`.
- [ ] 4.4 Render the handle on the top edge of each expanded pane only (never on a collapsed pane), wired to that pane's fraction setter; verify in `sessionListGrouped.test.tsx`.

## 5. Mobile drawer

- [ ] 5.1 Confirm the panes size correctly inside `.session-drawer`'s bounded flex column and adjust the drawer's height model only if the panes overflow it; verify in `sessionDrawer.test.tsx` that the drawer renders the same panes with the same stored fractions.
- [ ] 5.2 Verify a pane drag inside the drawer does not scroll or close the drawer; cover with an e2e case at a mobile viewport.

## 6. Verification

- [ ] 6.1 Add a Playwright case in `tests/e2e` asserting the `Remote` pane occupies ~25% of the sidebar height by default, that it scrolls independently of the sections above, and that a drag changes its share and survives a reload.
- [ ] 6.2 Add a Playwright case at a short viewport asserting the panes shrink proportionally while the change/worktree region keeps its minimum height and no header is clipped.
- [ ] 6.3 Run `bun run lint && bun run typecheck && bun run test` and the e2e suite; verify all pass.
- [ ] 6.4 Review the rendered sidebar with the `dev-browser` skill at default, collapsed, and resized states; verify the `Workspace` and `Remote` headers stay docked and legible in each.
