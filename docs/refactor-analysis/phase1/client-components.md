# Phase 1 — Mechanical metrics: `src/client/components/` (incl. chat/, settings/)

Scope: 48 .tsx/.ts files, 12,395 LOC. Excludes `__tests__`. Measured 2026-10-11 on master (2557b22).
"Hook count" = `grep -cE 'useState|useEffect'` (lines matching either). "Long comp" = component whose render+logic spans >~100 lines, with approx line range. TODO/FIXME/HACK/XXX: 0 across the entire scope. No file imports a server-side path; no file opens a `new WebSocket`.

## Section 1 — HOTSPOT TABLE (sorted by LOC desc)

| File | LOC | >500? | #exports | Long comps (line range) | Hooks | TODOs | Main problem |
|---|---|---|---|---|---|---|---|
| Terminal.tsx | 1768 | YES | 1 | Terminal 127–1768 (~1640) | 20 | 0 | Single monolithic component: xterm lifecycle, iOS resume state machine, drag&drop, mobile header/drawer, control deck, menus all in one; 22 refs, 13 effects; no header comment |
| SessionList.tsx | 928 | YES | 2 | SessionList 96–926 (~830) | 19 | 0 | One 830-line component mixing filtering, dnd reorder, fallback panes, and 3 near-identical collapsible section-header JSX blocks (Active ~722, Hibernating ~812, History ~855); odd EOF re-export of `formatRelativeTime`; no header comment |
| SessionPreviewContent.tsx | 877 | YES | 4 | SessionPreviewContent 604–877 (~273) | 10 | 0 | ~370 lines of pure log-parsing helpers (61–430) co-located with UI; direct `fetch` of preview API (line 582); three entry components share the expand/collapse pattern; no header comment |
| SessionRow.tsx | 768 | YES | 6 | SortableSessionItem 204–390 (~185); SessionRow 417–768 (~350) | 8 | 0 | SortableSessionItem and SessionRow duplicate a ~20-prop surface; two parallel status class maps (statusPillClass, SESSION_FIELD_EQUALS) |
| NewSessionModal.tsx | 752 | YES | 2 | NewSessionModal 97–752 (~655) | 18 | 0 | Single 655-line modal with 13 useState + 8 refs; inline focus-trap keydown (314–375); parallel preset/custom selection handlers (375–390); no header comment |
| WorkspaceSectionList.tsx | 589 | YES | 6 | WorkspaceSectionList 103–~210 (~108); GroupedLiveRows 476–589 (~113) | 3 | 0 | Five components + two exported constants in one file; fallback-pane layout logic split between here and SessionList's `renderFallbackPane` |
| SettingsModal.tsx | 450 | no | 1 | SettingsModal 45–450 (~405) | 25 | 0 | 405-line component with 25 useState acting as draft-owner for four tabs; no header comment |
| TerminalControls.tsx | 435 | no | 2 | TerminalControls 135–~433 (~298) | 3 | 0 | ~300-line component of key-button clusters; key-definition constants (88–100) embedded mid-file |
| ArrowKeys.tsx | 413 | no | 8 | ArrowKeys 101–413 (~312) | 9 | 0 | 312-line overlay component; 11 refs + 16 useCallbacks for pointer repeat logic |
| settings/SessionsSettings.tsx | 355 | no | 2 | SessionsSettings 36–355 (~320) | 5 | 0 | 320-line settings form in one component |
| settings/TerminalSettings.tsx | 340 | no | 2 | TerminalSettings 33–340 (~307) | 10 | 0 | 8 direct `fetch()` calls to /api/settings/* for self-saving toggles (66–148) mixed with draft form |
| NumPad.tsx | 314 | no | 2 | NumPad 86–314 (~228) | 5 | 0 | 228-line long-press overlay; geometry constants duplicated in style with ArrowKeys |
| chat/ChatView.tsx | 307 | no | 1 | ChatView 46–307 (~261) | 13 | 0 | 261-line component, 9 useEffect covering attach/reconnect/subscription/keyboard/menu state |
| DirectoryBrowser.tsx | 279 | no | 1 | DirectoryBrowser 12–279 (~265) | 8 | 0 | 265-line browser component with direct `fetch` (line 38); no header comment |
| HibernatingSessionItem.tsx | 263 | no | 1 | HibernatingSessionItem 28–263 (~235) | 7 | 0 | 235-line item component with inline rename/menu state; no header comment |
| ChatProviderSettings.tsx | 253 | no | 3 | ChatProviderSettings 71–251 (~180) | 8 | 0 | forwardRef component with direct `fetch` to /api/settings/chat-provider-env (line 54) |
| SessionDrawer.tsx | 243 | no | 1 | SessionDrawer 45–243 (~198) | 4 | 0 | Duplicates drawer content that Terminal.tsx also hosts for mobile |
| SectionHeader.tsx | 240 | no | 3 | — | 0 | 0 | Presentational, fine |
| HistorySessionItem.tsx | 179 | no | 1 | — | 3 | 0 | No header comment |
| BranchBrowserModal.tsx | 174 | no | 2 | — | 3 | 0 | — |
| CreateWorktreeModal.tsx | 164 | no | 2 | — | 4 | 0 | — |
| chat/ChatDebugPanel.tsx | 152 | no | 1 | ChatDebugPanel 47–152 (~105, borderline) | 5 | 0 | Borderline-length debug panel |
| ProjectFilterDropdown.tsx | 146 | no | 1 | — | 3 | 0 | No header comment |
| HostFilterDropdown.tsx | 141 | no | 1 | — | 3 | 0 | Near-twin of ProjectFilterDropdown (same dropdown pattern, useMemo-heavy); no header comment |
| ArchiveRows.tsx | 137 | no | 1 | — | 0 | 0 | — |
| settings/GeneralSettings.tsx | 133 | no | 2 | — | 0 | 0 | — |
| UpdatePanel.tsx | 129 | no | 1 | UpdatePanel 26–129 (~103, borderline) | 5 | 0 | Direct `fetch` POST /api/update/install (line 61) |
| PaneResizeHandle.tsx | 111 | no | 2 | — | 0 | 0 | — |
| SessionPreviewModal.tsx | 107 | no | 1 | — | 4 | 0 | No header comment |
| Header.tsx | 106 | no | 1 | — | 2 | 0 | No header comment |
| chat/ChatMessages.tsx | 105 | no | 1 | — | 0 | 0 | — |
| chat/toolCallLabel.ts | 92 | no | 2 | — | 0 | 0 | Pure helper, fine |
| Markdown.tsx | 86 | no | 1 | — | 0 | 0 | — |
| Toast.tsx | 84 | no | 2 | — | 0 | 0 | No header comment |
| AgentIcon.tsx | 84 | no | 1 | — | 0 | 0 | — |
| chat/UsageBar.tsx | 72 | no | 2 | — | 0 | 0 | — |
| PasteStatus.tsx | 69 | no | 1 | — | 3 | 0 | One-line header only |
| chat/ChatRequests.tsx | 65 | no | 1 | — | 2 | 0 | — |
| chat/useClaudeProfiles.ts | 58 | no | 1 | — | 7 | 0 | Hook with direct `fetch` (line 41) |
| chat/ChatActivityRow.tsx | 58 | no | 1 | — | 3 | 0 | — |
| Switch.tsx | 45 | no | 1 | — | 0 | 0 | No header comment |
| FontSizeStepper.tsx | 45 | no | 1 | — | 0 | 0 | — |
| chat/SlashCommandMenu.tsx | 43 | no | 1 | — | 0 | 0 | — |
| chat/ChatContextMeter.tsx | 43 | no | 2 | — | 0 | 0 | — |
| chat/slashCommandFilter.ts | 39 | no | 3 | — | 0 | 0 | Pure helper, fine |
| ProjectBadge.tsx | 24 | no | 1 | — | 0 | 0 | No header comment |
| HostBadge.tsx | 20 | no | 1 | — | 0 | 0 | No header comment |

Summary: 6 files exceed the 500-LOC norm. 15 files have no top-of-file header comment (Terminal, SessionList, SessionPreviewContent, NewSessionModal, SettingsModal, Header, DirectoryBrowser, HibernatingSessionItem, HistorySessionItem, HostBadge, HostFilterDropdown, ProjectBadge, ProjectFilterDropdown, SessionPreviewModal, Switch, Toast). No STALE headers found — spot-checked descriptive headers (SessionRow, WorkspaceSectionList, TerminalControls, settings/*, chat/*) all match current content. TODO/FIXME/HACK/XXX: 0.

## Section 2 — Files over 500 LOC

### Terminal.tsx (1768 LOC)
- Header comment: none (starts with imports).
- Exports (1): `default Terminal` — full terminal pane: xterm attach via `useTerminal`, mobile header + SessionDrawer, control deck session list, rename/kill/menus, iOS resume-input state machine, file drag&drop, preview content for read-only sessions.
- Long components: `Terminal` lines 127–1768 (~1640 lines) — one component for desktop and mobile variants.
- Hooks: 20 (useState|useEffect lines); plus 22 useRef, 11 useCallback, 2 useMemo.
- Duplication candidates:
  - Four parallel per-status lookup maps (`statusText` 93, `statusClass` 100, `statusButtonBase` 107, `statusButtonActive` 114) repeated for the same 4 states.
  - Mobile vs desktop status spans rendered twice (lines 1359–1363: `md:hidden` + `hidden md:inline` pair).
  - 20 inline `onClick={...}` handlers across header, deck, and menus; icon-button markup (XClose/DotsVertical/Menu01) repeated.
  - Control-deck session list duplicates selection/rename/kill handler shapes already passed in as props.

### SessionList.tsx (928 LOC)
- Header comment: none.
- Exports (2): `default SessionList` — flat/grouped session list: filtering, dnd-kit reorder, Active/Hibernating/History sections, fallback panes, loading skeleton; `formatRelativeTime` re-export at line 928 (re-export of an import at EOF; consumers could import from utils/time).
- Long components: `SessionList` lines 96–926 (~830).
- Hooks: 19; plus 13 useMemo, 10 useCallback, 5 useRef. Local `useTimestampRefresh` (line 83) for the 30s now-tick.
- Duplication candidates:
  - Collapsible section-header button JSX repeated near-verbatim three times: Active (~722–742), Hibernating (~812–838), History (~855–880) — same chevron/label/count button, only state variable and item renderer differ.
  - Per-item inline arrow wrappers (`onSelect={(sessionId) => ...}`, `onRename={(sessionId, newName) => handleRename(...)}`) repeated for each list kind.
  - `renderFallbackPane` (626–704) mirrors FallbackSectionPane composition done in WorkspaceSectionList.

### SessionPreviewContent.tsx (877 LOC)
- Header comment: none.
- Exports (4): `ParsedEntry` (interface, 30) — shared parsed-log entry shape; `dedupeAdjacentMessageEntries` (346) — merges adjacent same-role message entries; `groupEntriesForDisplay` (376) — pairs tool calls with results; `default SessionPreviewContent` (604) — fetches + renders a session's log preview as transcript or raw events.
- Long components: `SessionPreviewContent` 604–877 (~273). Sub-components are small: `ToolEntry` 431–463, `TranscriptEntry` 464–501, `StructuredLogEntry` 502–575.
- Hooks: 10; plus 6 useMemo, 4 useRef.
- Network: `fetchPreviewWindow` fetches the preview API directly (line 582, 10s abort timeout).
- Duplication candidates:
  - ~370 lines of parsing helpers (61–430: timestamp/format/JSON-compact/source-inference/parse functions) co-located with UI; a parsing module would be mechanical split.
  - Three entry components each re-implement an expand/collapse toggle with the same details/summary-ish pattern.

### SessionRow.tsx (768 LOC)
- Header comment: present, matches content (sortable wrapper + shared row).
- Exports (6): `statusPillClass` (32) — status→pill class map; `SESSION_FIELD_EQUALS` (93) — field-equality spec; `sessionsEqualForRender` (121) — memo equality for rows; `SortableSessionItemProps` (125); `SortableSessionItem` (204) — dnd-kit wrapper with framer-motion enter/exit; `SessionRow` (417) — the row itself.
- Long components: `SortableSessionItem` 204–390 (~185); `SessionRow` 417–768 (~350).
- Hooks: 8; plus 12 useCallback, 6 useRef.
- Duplication candidates:
  - `SortableSessionItem` and `SessionRow` declare nearly identical ~20-prop parameter lists (selection, editing, rename, hibernate, archive, restore, kill, duplicate...); every consumer passes the same set twice-shaped.
  - Two status→class maps in one file (`statusPillClass` here; Terminal.tsx keeps three more of its own).

### NewSessionModal.tsx (752 LOC)
- Header comment: none.
- Exports (2): `NewSessionWorktreeOption` (interface, 12) — worktree picker option; `default NewSessionModal` (97) — new-session form: project path + browser, terminal/chat kind, preset vs custom command, host, start-with (branch/change), auto-approve.
- Long components: `NewSessionModal` 97–752 (~655).
- Hooks: 18 (13 useState + 6 useEffect, some co-line); 8 useRef.
- Duplication candidates:
  - Inline focus-trap `handleKeyDown`/`getFocusableElements` (314–375) — a generic modal concern embedded in this one modal.
  - `handlePresetSelect` (375) vs `handleCustomSelect` (383) — parallel selection handlers over the same command state.

### WorkspaceSectionList.tsx (589 LOC)
- Header comment: present, matches content (sectioned navigator + docked fallback panes).
- Exports (6): `GroupedRowContext` (43, interface) — row-callback bundle threaded through sections; `default WorkspaceSectionList` (103) — OpenSpec change/worktree sections with per-section dnd contexts; `FLOW_REGION_MIN_HEIGHT` (213); `PANE_MIN_HEIGHT` (219); `FallbackSectionPaneProps` (234); `FallbackSectionPane` (264) — docked pane for Workspace/Remote/Archive sections.
- Components: `WorkspaceSectionList` 103–~210 (~108); `FallbackSectionPane` 264–~345 (~80); `FallbackSectionHeader` 346–433 (~87); `DormantToggle` 434–464; `GroupedLiveRows` 476–589 (~113).
- Hooks: 3; plus 5 useCallback, 2 useMemo.
- Duplication candidates: header/collapse trigger logic overlaps SectionHeader.tsx; fallback-pane placement is co-owned with SessionList's `renderFallbackPane`.

## Section 3 — Files at or under 500 LOC

- SettingsModal.tsx (450): 405-line tab shell owning 25 useState drafts for all tabs; no header comment.
- TerminalControls.tsx (435): ~298-line mobile key strip; key constants embedded mid-file.
- ArrowKeys.tsx (413): ~312-line arrow overlay; 11 refs / 16 useCallbacks for press-repeat.
- settings/SessionsSettings.tsx (355): ~320-line form; presets + ordering + switches in one component.
- settings/TerminalSettings.tsx (340): ~307-line form; 8 direct `fetch()` calls to /api/settings/* (lines 66–148) for self-saving toggles.
- NumPad.tsx (314): ~228-line long-press pad; geometry constants parallel to ArrowKeys.
- chat/ChatView.tsx (307): ~261-line chat attach/subscription/composer/menu component; 9 useEffect.
- DirectoryBrowser.tsx (279): ~265-line browser; direct `fetch` (38); no header comment.
- HibernatingSessionItem.tsx (263): ~235-line item with inline rename/menu; no header comment.
- ChatProviderSettings.tsx (253): ~180-line forwardRef section; direct `fetch` to /api/settings/chat-provider-env (54).
- SessionDrawer.tsx (243): ~198-line mobile drawer duplicating Terminal-hosted drawer content.
- SectionHeader.tsx (240): presentational section header + CollapseTrigger; fine.
- HistorySessionItem.tsx (179): memoized history row; no header comment.
- BranchBrowserModal.tsx (174): branch list + worktree assignment modal.
- CreateWorktreeModal.tsx (164): create-worktree form modal.
- chat/ChatDebugPanel.tsx (152): ~105-line protocol-frame debug panel (borderline).
- ProjectFilterDropdown.tsx (146): filter dropdown; no header comment.
- HostFilterDropdown.tsx (141): near-twin of ProjectFilterDropdown; no header comment.
- ArchiveRows.tsx (137): interleaved archive pane rows.
- settings/GeneralSettings.tsx (133): presentational General tab.
- UpdatePanel.tsx (129): ~103-line update dialog; direct `fetch` POST /api/update/install (61).
- PaneResizeHandle.tsx (111): pointer+keyboard resize handle.
- SessionPreviewModal.tsx (107): preview modal shell; no header comment.
- Header.tsx (106): top header bar; no header comment.
- chat/ChatMessages.tsx (105): read-only transcript with paired tool entries.
- chat/toolCallLabel.ts (92): pure tool-label helpers.
- Markdown.tsx (86): shared markdown renderer.
- Toast.tsx (84): toast manager singleton + viewport; no header comment.
- AgentIcon.tsx (84): agent-type icon.
- chat/UsageBar.tsx (72): plan usage meters.
- PasteStatus.tsx (69): paste progress/error strip.
- chat/ChatRequests.tsx (65): pending approvals/questions renderer.
- chat/useClaudeProfiles.ts (58): profile-catalog hook; direct `fetch` (41).
- chat/ChatActivityRow.tsx (58): live activity row with 1s client tick.
- Switch.tsx (45): toggle; no header comment.
- FontSizeStepper.tsx (45): labeled stepper.
- chat/SlashCommandMenu.tsx (43): presentational slash menu.
- chat/ChatContextMeter.tsx (43): context-usage chip + token formatter.
- chat/slashCommandFilter.ts (39): pure filter/rank helpers.
- ProjectBadge.tsx (24): project badge; no header comment.
- HostBadge.tsx (20): host badge; no header comment.

## Section 4 — Client components reaching network / server paths

No `new WebSocket` and no server-side imports anywhere in scope. Direct `fetch()` calls:

- settings/TerminalSettings.tsx — 8 fetches to `/api/settings/*` (lines 66, 71, 87, 91, 100, 117, 132, 148).
- ChatProviderSettings.tsx — `/api/settings/chat-provider-env` (line 54).
- SessionPreviewContent.tsx — preview API (line 582).
- DirectoryBrowser.tsx — directory listing API (line 38).
- useClaudeProfiles.ts — profile catalog fetch (line 41).
- UpdatePanel.tsx — `/api/update/install` POST (line 61).
