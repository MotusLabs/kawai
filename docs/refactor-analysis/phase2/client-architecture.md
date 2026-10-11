# Phase 2 — Client Architecture Review (`src/client/`, `src/shared/`)

Scope: architecture + business-logic analysis of the client, verified against code on master (2557b22). Phase 1 triage treated as leads; every claim relied on below was re-verified, and corrections are called out. Non-test client code ≈ 20.0k LOC (12.4k components + 7.6k core/hooks/stores/utils). Test suite: 60 client test files + 7 shared, covering all hotspots (notably `app.test.tsx` 2,395 LOC, `useTerminal.test.tsx` 5,046 LOC, `websocketManager.test.ts` 1,589 LOC).

---

## §1 Executive verdict

**Partially — yes, decisively, for three files; no for the state and protocol layers.** App.tsx, useTerminal.ts, and Terminal.tsx are 5,135 LOC (25% of the client) concentrated in exactly three god-units whose sizes (1,351 / 2,016 / 1,768) each exceed the project's own 500-LOC norm by 2.5–4x, and they own the hardest correctness logic in the app (message routing, attach/backpressure, iOS input) with the least structure. Everything around them is healthy: the WebSocket contract in `src/shared/types.ts` is a complete, fully-typed discriminated union with zero `any` drift, the Zustand stores use fine-grained selectors everywhere with no re-render storms, and the list/navigator components (`WorkspaceSectionList`, `SessionRow`, `ArchiveRows`) show deliberate, documented design. The right move is targeted decomposition of the terminal trio plus one protocol-routing extraction — not a rewrite.

---

## §2 Architecture map as-is

```
WebSocketManager (singleton, hooks/useWebSocket.ts:103-713)
  │  connect/backoff, iOS verify-then-reconnect, heartbeat, epoch counter
  │  parses JSON once, attaches _parseMs/_rawLength diagnostics, swallows 'pong'
  ▼
listener fan-out (Set<MessageListener>) — 3 live subscribers:
  1. App.tsx subscribe effect (App.tsx:214-596) — the router
     ├─ session domain   : sessions, session-update/created/removed/orphaned/
     │                     activated, wake/hibernate/move-to-history results,
     │                     kill-failed → sessionStore (+ pendingKills ref,
     │                     pendingHibernate/WakeSelection refs, sound transitions)
     ├─ agent domain     : agent-sessions, agent-sessions-active → sessionStore
     ├─ workspace domain : workspace-snapshot, workspace-operation-result
     │                     → workspaceStore (+ pendingWorktreeLaunch refs → opens
     │                     NewSessionModal via local useState)
     ├─ server/config    : host-status, server-config, update-state, error
     │                     → sessionStore / updateStore / local serverError
     └─ chat domain      : chat-events/snapshot/commands/activity/
                           context-usage/usage, chat-debug-frames
                           → chatStore / chatDebugStore (store reducers, one line each)
  2. useTerminal output subscriber (useTerminal.ts:1586-1863) — terminal-output,
     terminal-ready, terminal-error, clipboard-offer, tmux-copy-mode-status
     (output buffering + write backpressure, attach lifecycle at 1328-1561)
  3. ChatView subscription (chat/ChatView.tsx:99-117) — session-created/error,
     only while a pending /clear awaits its new chat
Stores (Zustand, all field-selected at call sites):
  sessionStore   sessions/selection/connection/remote-config; persisted: selection only
  chatStore      transcripts+drafts+usage; pure reducer applyChatEvents (chatStore.ts:53-91)
  settingsStore  25 persisted prefs + presets (16 non-test importers, all selector-based)
  workspaceStore snapshot + collapse state (parse-validated, stale-retention)
  themeStore / updateStore / chatDebugStore — small, single-purpose
Derived state:
  App.tsx        sortedSessions/filteredSorted/workspaceView/navigation* memos (639-748)
  SessionList    its own sorted/filtered memos + rowContext bundle (251-376, 540-600)
  workspaceView.ts buildWorkspaceView — pure selector, shared
Rendering: App → (desktop) Header + SessionList + Terminal|ChatView;
           (mobile) Terminal hosts header/drawer/control-deck; SessionDrawer wraps
           the SAME SessionList (no content duplication — Phase 1 claim corrected)
HTTP (outside WS): 10 raw-fetch sites — see §3 F4.
```

Reconnect/resume flow (verified sound, details in §3 F16): epoch increments per socket open (`useWebSocket.ts:222`); `useTerminal` clears its snapshot cache and re-attaches on epoch mismatch (`useTerminal.ts:1358-1378, 1407-1409`); server resends sessions/workspace-snapshot/chat-snapshot on open; ChatView re-attaches on epoch change (`ChatView.tsx:65-69`); `agentSessionsEpoch` gates stale selection fallbacks (`App.tsx:837`); drafts are client-only by design and die on reload (documented in CLAUDE.md and `chatStore.ts:1-11`).

---

## §3 Findings

Severity: **high** = blocks feature work / concentrates correctness risk; **med** = real cost, bounded; **low** = polish.

**F1 (high) — App.tsx is the message router, and the router is an effect.**
Evidence: `App.tsx:214-596` — one ~382-line closure handling 27 message types inline (28 minus `terminal-output` early-return at 216-218). Business logic embedded there: pendingKills epoch-filtering and rollback (243-261, 549-567), pending hibernate/wake selection matching with filter awareness (281-314, 440-464), worktree-launch-to-modal handoff (327-369), filter auto-extend on session-created (411-415).
Why it matters: every protocol addition edits the root component; the handler logic is only testable through full `App` renders; and the effect's dep array (577-596) includes `selectedSessionId`/`selectedHibernatingSessionId` (used only by the `terminal-error`/`terminal-ready` gating at 526-536), so **the entire router unsubscribes and resubscribes on every session selection change**. Because passive effects flush after paint, a message arriving in that window is handled by the previous closure with stale selection values. Most handlers already read `useSessionStore.getState()` — these two are the exception, not the rule. Phase 1 verified (effect ~382 lines, ~25+ types: actual 27).

**F2 (high) — useTerminal.ts: one 1,683-line hook body owning ≥10 separable responsibilities.**
Verified inventory (line ranges):
1. module-level serialize snapshot cache (19-32) — session-switch instant restore;
2. dropped-output rate-limited diagnostics (34-64);
3. terminal instance + addon creation, font-gated open (609-1236, the ~627-line mount effect, `eslint-disable exhaustive-deps` at 1235);
4. link tooltip + WebLinks + OSC-8 handlers (718-829);
5. paste-resolution state machine — per-request resolver promise, capture-phase listener, macOS pasteboard paths, image upload fallbacks (113-235, 831-1093);
6. custom key handler: nav digits, Cmd+C, Ctrl+V mac image paste, paste modifier, Ctrl+Backspace (858-1062);
7. tmux copy-mode tracking: wheel→SGR translation, optimistic set, debounced checks, 750ms poll, mouse-tracking enable/disable (555-588, 1122-1174, 1563-1582, 1831-1848);
8. attach/detach lifecycle with snapshot serialize/restore, microtask-vs-debounced attach, epoch guards (1308-1561);
9. output buffering + write backpressure with generation-token ack invalidation (431-469, 1586-1863);
10. iOS repaint + WebGL resurrection (471-531, 1904-1991).
Duplications verified (Phase 1 numbers confirmed, slightly corrected): WebGL-create-with-context-loss x3 (671-686, 1282-1294, 1940-1948); detach-state reset x4 (1341-1348, 1364-1371, 1397-1403, 1541-1545); `tmux-cancel-copy-mode`+`setTmuxCopyMode(false)` pair x4 in this file (850-853, 899-902, 1024-1027, 1112-1115) **plus 4 more in Terminal.tsx** (244-246, 1157-1160, 1168-1171, 1196-1198) = 8 sites; `/api/clipboard-file-path` fetch+parse x2 (138-148 helper, 987-1005 inline — the inline copy is the one that got the richer error semantics).
Why it matters: this file concentrates the app's subtlest correctness (backpressure D7, attach races, iOS WebKit bugs) in a shape where edits require holding ~40 refs in mind; the duplicated blocks are exactly how the next regression slips in (the inline clipboard fetch already diverged from its helper).

**F3 (high) — Terminal.tsx: 1,640-line component, ~800 lines of which are iOS/touch input machinery, plus a 12-prop drill-through for the mobile drawer.**
Evidence: iOS selection tracking/a11y repaint (329-494), a11y overlay sync (496-575), iOS resume-input state machine (599-678), touch scroll/momentum/remote-selection (680-1140), mobile header + tab strip + more-menu (1310-1520), hibernation pane (1581-1642), kill modal (1739-1765). Props `historySessions`, `hibernatingSessions`, `onResume/onHibernate/onMoveToHistory/onArchiveChat/onRestoreChat/onNewSession`, `workspaceView`, `onToggleSectionCollapse`, `onNewSessionInWorktree`, `onCreateChangeWorktree`, `onBrowseBranches`, `loading`, `error` (Terminal.tsx:53-89) are consumed **only** by the embedded `SessionDrawer`→`SessionList` (1710-1736) — Terminal is a pass-through for half its surface.
Correction of Phase 1: SessionDrawer does **not** duplicate drawer content — it wraps the same `SessionList` the desktop sidebar uses (`SessionDrawer.tsx:179-224`). The cost is prop drilling, not code copy.

**F4 (med) — No data-fetching layer; 10 files issue raw `fetch`, with inconsistent error semantics.**
Verified inventory (Phase 1's "6 components" undercounts): `App.tsx:1205` (server-info, silent catch), `settings/TerminalSettings.tsx` x8 (66-148), `ChatProviderSettings.tsx:54`, `SessionPreviewContent.tsx:582` (the only one with typed error extraction + timeout + abort), `DirectoryBrowser.tsx:38`, `UpdatePanel.tsx:61`, `chat/useClaudeProfiles.ts:41`, `useTerminal.ts:124/140/989` (silent null returns), `utils/browserFiles.ts:29`, `utils/clientLog.ts:38`.
Why it matters: three incompatible failure modes coexist — silent-swallow (App, TerminalSettings loads, useTerminal), revert-on-failure (TerminalSettings PUTs), surfaced-error (SessionPreviewContent). A hung `/api/server-info` has no timeout; JSON parse of a proxy HTML error page would throw unhandled in several of these.

**F5 (med) — TerminalSettings contains four near-identical self-saving-setting blocks.**
Evidence: `settings/TerminalSettings.tsx:97-158` — tmux-mouse-mode, prefer-window-name, terminal-colors, history-max-age-hours each repeat load-on-mount + optimistic PUT + revert-on-!ok + loading flag (~25 lines each). Also note `preferWindowName` here is local component state while `sessionStore.preferWindowName` holds the server-config push (`App.tsx:375`) — two sources for one flag; the switch won't track an external push while the modal is open.

**F6 (med) — The "session passes filters" predicate is re-implemented 9 times across 3 files.**
Evidence: `App.tsx:56-62` (`filterAgentSessions`), 296-308 (pending-wake match, inline), 413-415 (filter auto-extend), 651-658 (`filteredSortedSessions`); `SessionList.tsx:294-303, 356-365, 367-376`; `workspaceView.ts:30/40` (parameterized helper).
Why it matters: App and SessionList each compute their own filtered views of the same sessions; the predicate's edge cases (missing host → `''`) must stay in lockstep or keyboard navigation and visible list disagree.

**F7 (med) — In-handler duplication in the App router.**
Evidence: sound-transition logic duplicated between `sessions` (222-237) and `session-update` (380-400); `create-worktree` vs `create-change-worktree` result handling near-identical (327-349 vs 351-369); `setServerError(...)` + `window.setTimeout(..., 6000)` repeated **8x** (348, 367, 511-512, 522-523, 528-529, 538-539, 565-566, 570-571 — Phase 1 said 7, actual 8). The timeouts are never cleared on unmount.

**F8 (med) — HostFilterDropdown / ProjectFilterDropdown are ~90% structural twins.**
Evidence: identical open/outside-click/escape effect (`Host:39-58` ≡ `Project:40-59`), identical toggle-and-reorder logic (60-69 ≡ 61-70), same button/menu markup; deltas are icon, label formatting, host-status decorations, and the permission dot. Both also re-implement the outside-click pattern that exists as `useOnClickOutside` (`hooks/useOnClickOutside.ts`) and again in `SessionRow.tsx:533-556`.

**F9 (med) — SessionPreviewContent co-locates ~370 lines of pure log-parsing with UI.**
Evidence: `SessionPreviewContent.tsx:61-430` — timestamp extraction/formatting, JSON compaction, readable-text extraction, source inference, `dedupeAdjacentMessageEntries` (346), `groupEntriesForDisplay` (376) — all pure, plus a bespoke fetch-with-abort/timeout (581-596, 623-660). Verified Phase 1 claim. This parsing is a parallel implementation to the server's `eventTaxonomy` (it imports from it) — the client-side half deserves its own module and tests beside `sessionPreviewDedup.test.ts`.

**F10 (low) — settingsStore is large but is NOT a re-render god store.**
Evidence: 508 LOC, ~29 exports (verified), 16 non-test importers (Phase 1 said 18; measured 16) — **every import site uses a field selector** (`App.tsx:118-134`, `Terminal.tsx:160-167`, `SessionList.tsx:127-222`); zero whole-store subscribes found. Real costs are boilerplate (interface + setter + impl = 3 lines per field, 149-333), mixed domains (terminal prefs / navigator layout fractions / command-preset CRUD + 113-line migration, 358-471), and 13 constants double-named via the re-export block (476-489). Severity low because the mechanics are fine; this is ergonomics.

**F11 (low) — Store/App responsibility split is inverted in places.**
`sessionStore.setSessions` embeds selection-fallback + exiting-animation policy (`sessionStore.ts:121-180`), reading `useSettingsStore.getState()` for sort order — orchestration inside a setter. Meanwhile genuinely shared session logic (kill rollback, wake selection) lives in App refs. Neither is wrong today; both make the eventual router extraction (P1-1) the natural place to consolidate.

**F12 (low) — SessionRow/SortableSessionItem ~20-prop surface is deliberate, not accidental.**
Verified: `SortableSessionItemProps` (25 props, 125-157) vs `SessionRowProps` (18, 393-415) with ~12 overlapping; the wrapper binds id-taking handlers to zero-arg ones and gates availability (`SessionRow.tsx:267-302`), behind exhaustively-typed comparator tables (93-118, 165-195). Phase 1's "duplicate ~20-prop surface" is real but the root cause is the memoization design (D6), not a missing abstraction. Cost: every new action = 4 coordinated edits. A grouped `actions` object would halve it but risk the comparator exhaustiveness trick — only worth it when it next hurts.

**F13 (low) — Stray EOF re-export.** `SessionList.tsx:928` re-exports `formatRelativeTime`; only `sessionList.test.ts` imports it from there. Consumers should use `utils/time`.

**F14 (low) — Status presentation maps scattered.** `Terminal.tsx:93-119` (4 parallel maps), `SessionRow.tsx:32-37` (`statusPillClass`), inline mobile/desktop status spans duplicated (`Terminal.tsx:1359-1364`). One `sessionStatusPresentation.ts` module would own text/class pairs.

**F15 (positive) — The protocol contract is complete; no untyped drift.**
`src/shared/types.ts` `ServerMessage` is a 30-member discriminated union; cross-checked against every server broadcast in `src/server/index.ts` (session/workspace/terminal/config families) and `src/server/chat/` (chat-* family) — all covered. `ClientMessage` likewise. grep found zero `as any` / `: any` in non-test client code. `shared/chat.ts` is SDK-agnostic, documented, and pairs with the pure reducer `applyChatEvents` (`chatStore.ts:53-91`) — the best code in the client; use it as the template for P1-1.

**F16 (med) — Reconnect/resume ordering: sound design, two concrete hazards.**
Sound parts (verified): epoch-guarded re-attach in useTerminal (1407-1409), snapshot-cache clearing on disconnect (1373), `agentSessionsEpoch` gate before hibernating-selection fallback (`App.tsx:837`), ChatView re-attach keyed on epoch (`ChatView.tsx:65-69`), authoritative chat snapshot replace (`chatStore.snapshot`, 120-136), pendingKills epoch discard on first post-reconnect snapshot (243-250). Hazards: (a) the F1 stale-closure window on selection change (passive effect flush timing); (b) `/api/server-info` refetch keyed on `connectionEpoch` (`App.tsx:1204-1212`) has no stale-response guard — a slow response from epoch N can overwrite epoch N+1's info (benign today since the payload is idempotent, but unguarded). No hazard found between WS re-subscribe and pending fetches beyond these.

---

## §4 Recommendations

Ordered; each: problem → change → risk → effort (S <半天 / M <2天 / L >2天) → verification.

### P1-1. Extract the WS router from App.tsx into a table-driven protocol module
Problem: F1, F7, F16(a).
Change: new `src/client/protocol/` with
- `messageRouter.ts` — `createMessageRouter(deps)` returning `(msg) => void`; deps = `{ sendMessage, getConnectionEpoch, ui: { openNewSessionPrefilled, setTransientError } }`;
- `sessionMessages.ts` (sessions/update/created/removed/orphaned/activated/wake/hibernate/kill-failed/move-to-history + pendingKills + pending selection refs owned in a small `pendingSessionOps` object),
- `workspaceMessages.ts` (snapshot/operation-result + launch refs),
- `chatMessages.ts` (the eight one-line store dispatches, mirroring the server's additive `chat-*` naming),
- `serverMessages.ts` (host-status/server-config/update-state/error/terminal-error/terminal-ready).
Handlers read stores via `getState()` exclusively (dropping `selectedSessionId` from the effect deps so the router subscribes once for the app's lifetime). Fold in the F7 dedupes: one `notifyStatusTransitions(prev, next)`, one `handleWorktreeResult(pendingRef, result)`, one transient-error helper with timer cleanup.
Risk: **medium** — behavior parity for ordering-sensitive handlers (pendingKills epoch discard, pending-wake matching). Mitigated by dispatching through the same store methods in the same order.
Effort: **M**.
Verification: `app.test.tsx` (2,395 LOC) already exercises router behavior end-to-end; add `protocol/messageRouter.test.ts` dispatching all 27 types against store spies (cheap once handlers are plain functions). `bun run test` + `typecheck`.

### P1-2. Decompose useTerminal.ts into composables under `src/client/terminal/`
Problem: F2.
Change (concrete modules, refs stay hook-owned, logic moves out):
- `terminal/webgl.ts` — `loadWebglAddon(terminal, onContextLoss)` replacing the 3 copies;
- `terminal/attachState.ts` — the detach-reset and attach-bookkeeping (`detachFrom(prevAttached)`, cancel-pending-attach), replacing the 4 copies;
- `terminal/copyMode.ts` — `exitTmuxCopyMode(send, sessionId)` for the 8 paired sites, plus the status-tracking state (optimistic set, debounced check, poll, mouse-tracking writes);
- `terminal/outputStream.ts` — buffer + flush timers + backpressure w/ generation token as a class (pure-ish, directly unit-testable — currently only testable through the hook);
- `terminal/pasteChannel.ts` — resolver promise machinery + `resolveImagePasteData` + single `fetchClipboardImagePath` (delete the 987-1005 inline copy);
- `terminal/snapshotCache.ts`, `terminal/iosRepaint.ts`, `terminal/droppedOutputLog.ts` — mechanical moves of the module-level blocks;
- `useTerminal.ts` shrinks to composition + the subscribe effect (~400-500 LOC).
Risk: **medium** — effects share refs; keep ref ownership in the hook and pass setters into modules so lifecycles stay identical. Do it in 3-4 commits (mechanical moves first, behavioral dedupe second).
Effort: **L**.
Verification: `useTerminal.test.tsx` (5,046 LOC) + `terminal.test.tsx` cover attach, backpressure, copy-mode, paste; add unit tests for `outputStream` and `pasteChannel` that were previously impossible.

### P1-3. Split Terminal.tsx; host the mobile drawer at App level
Problem: F3.
Change:
- `TerminalMobileChrome.tsx` (header + tab strip + more menu + kill modal), `HibernatingSessionPane.tsx` (1581-1642);
- hooks: `useIOSTerminalSelection.ts` (329-494), `useTerminalTouchInput.ts` (680-1140), `useIOSResumeInput.ts` (599-678), `useA11yOverlaySync.ts` (496-575);
- move `<SessionDrawer>` (and its 12 props) from Terminal.tsx:1710-1736 up to `App.tsx` next to the desktop `SessionList` — App already owns every one of those handlers, so the drill-through disappears instead of being re-wrapped.
Risk: **low-medium** — the iOS hooks interact via shared refs (`swallowNextMouseRef`, `iosResumeInputStateRef`, `clearIOSSelectionRef`); group them in one `useIOSInput()` bundle that owns the refs and returns the three surfaces.
Effort: **M**.
Verification: `terminal.test.tsx`, `sessionDrawer.test.tsx`, `terminalControls.test.tsx`; `dev-browser` walkthrough on a mobile viewport for the touch paths.

### P2-1. Shared API client + `useServerSetting` hook
Problem: F4, F5.
Change: `src/client/api/client.ts` — `fetchJson<T>(url, {timeoutMs, signal, method, body})` with typed error extraction (lift `SessionPreviewContent.tsx:581-596`'s pattern); `api/settings.ts` exposing `useServerSetting<T>(endpoint, defaultValue)` (load + optimistic PUT + revert + loading, param'd on the four TerminalSettings blocks); migrate the 8 component-level fetch sites. Keep `useTerminal`'s paste fetches on it too (null-return semantics preserved via option).
Risk: **low**. Effort: **M**. Verification: existing `chatProviderSettings.test.tsx`, `DirectoryBrowser.test.tsx`, `updateSurface.test.tsx`, `settingsModal.test.tsx`; add client tests for timeout/abort/non-JSON error bodies.

### P2-2. `sessionMatchesFilters(session, {projectFilters, hostFilters})` util
Problem: F6. Change: `utils/sessionFilters.ts`; replace the 9 sites in App/SessionList (workspaceView already parameterizes internally — have it consume the same util). Risk: **low**. Effort: **S**. Verification: `sessionListFilters.test.tsx`, `app.test.tsx`, `workspaceView.test.ts`.

### P2-3. FilterDropdown shell
Problem: F8. Change: `components/Filters/MultiSelectFilterDropdown.tsx` owning open state, outside-click/escape (reuse `useOnClickOutside`/`useEscapeToClose`), button + menu markup, toggle-and-reorder; Host/Project become ~40-line configs with an item render-prop. Risk: **low** (aria attributes must survive — `projectFilterDropdown.test.tsx` asserts them). Effort: **S**.

### P2-4. Extract preview-log parsing
Problem: F9. Change: `src/client/components/preview/parsePreviewLog.ts` (pure helpers + `ParsedEntry`), leaving the UI component ~450 LOC; move `sessionPreviewDedup.test.ts` beside it. Risk: **low**. Effort: **S**.

### P2-5. Status presentation module
Problem: F14. Change: `utils/sessionStatusPresentation.ts` with `statusText/statusClass/statusButton*/statusPillClass`; consume from Terminal.tsx and SessionRow.tsx. Risk: **low**. Effort: **S**. Verification: `renderComponents.test.tsx` + snapshot-ish assertions in `sessionList.test.ts`.

### P3-1. settingsStore slimming (ergonomics only)
Move preset helpers/migration to `utils/presets.ts`; export constants from `utils/settingsConstants.ts` (drop the 476-489 double-naming); optionally relocate the three pane-fraction prefs to workspaceStore. No behavioral change; do it opportunistically when P2-1 touches settings. Effort **M**, risk low.

### P3-2. SessionRow action-bundle
Only when the next action is added: group the 8 action callbacks into one `SessionRowActions` object prop (comparator compares fields of the bundle). Keeps the exhaustive-table trick. Effort **S**.

### P3-3. Remove `SessionList.tsx:928` re-export; point `sessionList.test.ts` at `utils/time`. Effort **S**. Add a stale-response guard to the `/api/server-info` epoch fetch (compare epoch before `setServerInfo`). Effort **S**.

---

## §5 What NOT to refactor

1. **`useWebSocket.ts`'s WebSocketManager** — the iOS verify-then-reconnect deviation from industry consensus is documented (file header 1-31), load-bearing (zombie-socket purge, leaked-socket tracking, resume settle), and covered by 1,589 LOC of tests. Replacing it with a generic reconnect library would regress the exact failure modes it was built for.
2. **The write-backpressure generation-token design** (useTerminal D7, 431-469/1586-1863) — subtle and currently correct across session-switch/cleanup/terminal-ready boundaries. Extract it (P1-2) but preserve its semantics verbatim; do not "simplify" the identity+generation pair into a boolean.
3. **SessionRow's exhaustive comparator tables** (`SESSION_FIELD_EQUALS`, `ITEM_PROP_EQUALS`) — the mapped-type exhaustiveness (adding a Session field without an entry is a type error) plus 30s activity bucketing is deliberate render-churn control (design D6). Shallow-compare "cleanup" would reintroduce re-render storms.
4. **Zustand store granularity / no state-library change** — all call sites use field selectors; no whole-store subscribe exists; the chatStore pattern (pure reducer + thin store) is exemplary. Splitting settingsStore further or moving to another library buys nothing measurable.
5. **`shared/types.ts` + `shared/chat.ts` contract and the additive-message discipline** (`chat-activity`, `chat-usage`, `workspace-*`) — verified drift-free; the additive pattern is what makes P1-1 safe to do incrementally. Keep extending, don't restructure.
6. **`flushSync` in `handleKillSession`** (App.tsx:948) — intentional synchronous paint guarantee for optimistic kill removal, with a comment explaining why. Not a "React anti-pattern to fix".
7. **pendingKills / pending-selection epoch-guard orchestration** (App.tsx:239-261, 750-811; comments explain the stale-refresh resurrection window) — correct as written; P1-1 must relocate, not redesign it.
8. **GroupedRowContext bundle + per-section DndContext** (WorkspaceSectionList) — the context bundle is what keeps memoized rows stable across two render sites; per-section drag confinement is structural (documented in the file header). The SessionList/WorkspaceSectionList fallback-pane split is likewise by design (SessionList places and persists pane fractions; WorkspaceSectionList renders) — Phase 1's "co-ownership" framing was a misread of a deliberate boundary.
9. **chatStore drafts as client-only, never-persisted state** — documented product decision (CLAUDE.md; chatStore header); resist "fixing" it into localStorage during the store work.
