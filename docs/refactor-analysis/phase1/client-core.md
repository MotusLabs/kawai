# Phase 1 — Client Core (src/client root, hooks/, stores/, utils/)

Scope: .ts/.tsx in `/home/coder/kawai/src/client/` root + hooks/ + stores/ + utils/, excluding __tests__. 40 files, ~7.6k LOC. Read-only audit; no repo files modified.

## Section 1: HOTSPOT TABLE (sorted by LOC desc)

| File | LOC | >500? | #exports | Long funcs/comps (>100 lines) | TODOs | Main problem |
|---|---|---|---|---|---|---|
| hooks/useTerminal.ts | 2016 | YES | 6 | `useTerminal` 333–2016 (~1683); mount effect 609–1236 (~627); attach/detach effect 1328–1561 (~233); output-subscriber effect 1586–1863 (~277) | 0 | Monolith hook mixing xterm lifecycle, paste/image handling, tmux copy-mode, backpressure, iOS repaint and WebGL recovery; 3x duplicated WebGL-create and 4x duplicated detach-reset blocks |
| App.tsx | 1351 | YES | 1 | `App` 65–1351 (~1286); WS subscribe effect 214–596 (~382) | 0 | Root component is the app: message-router effect handles ~25 message types inline; duplicate sound-transition and create-worktree result logic; no header comment |
| hooks/useWebSocket.ts | 753 | YES | 2 | `WebSocketManager` class 103–713 (~610); `connect()` 148–285 (~137) | 0 | 610-line connection-manager class (justified complexity for iOS resume, but co-located in a hook file); header comment accurate |
| stores/settingsStore.ts | 508 | YES (marginal) | ~29 | `migrate()` 358–471 (~113) | 0 | 25+ persisted fields each need a SettingsState line + setter + create() entry; ~13 constants re-exported from the store module; no header comment |
| utils/workspaceView.ts | 347 | no | 9 | `buildWorkspaceView` 170–347 (~177) | 0 | Single 177-line selector building the whole sectioned view |
| stores/sessionStore.ts | 270 | no | 2 | `create()` store block 103–270 (~167) | 0 | Widely imported (10 non-test importers); store block is one 167-line object literal |
| utils/sound.ts | 214 | no | 4 | none | 0 | Module-import-time side effects (listeners + interval at lines 63–90) |
| hooks/useVisualViewport.ts | 193 | no | 3 | mount effect 72–192 (~120) | 0 | One large effect wiring 6 listeners + rAF burst + polling |
| stores/chatStore.ts | 175 | no | 5 | none | 0 | — |
| utils/sessions.ts | 140 | no | 5 | none | 0 | No header comment |
| utils/a11yRowStability.ts | 135 | no | 1 | none | 0 | Prototype-patching of xterm internals (by design, iOS workaround) |
| stores/workspaceStore.ts | 116 | no | 1 | none | 0 | Only 1 non-test importer |
| utils/storage.ts | 107 | no | 2 | none | 0 | No header comment |
| utils/chatWireFrames.ts | 100 | no | 7 | none | 0 | — |
| hooks/useBrowserPaste.ts | 92 | no | 3 | none | 0 | — |
| utils/sessionLabel.ts | 88 | no | 3 | none | 0 | No header comment |
| stores/chatDebugStore.ts | 81 | no | 6 | none | 0 | — |
| stores/themeStore.ts | 78 | no | 3 | none | 0 | No header comment |
| hooks/useEdgeSwipeToOpenDrawer.ts | 76 | no | 1 | none | 0 | — |
| utils/device.ts | 75 | no | 9 | none | 0 | No header comment |
| utils/browserFiles.ts | 64 | no | 5 | none | 0 | — |
| hooks/useExitCleanup.ts | 58 | no | 1 | none | 0 | — |
| utils/clientLog.ts | 46 | no | 2 | none | 0 | No header comment |
| stores/updateStore.ts | 44 | no | 2 | none | 0 | — |
| main.tsx | 44 | no | 0 | none | 0 | No header comment |
| hooks/useCounterBump.ts | 44 | no | 1 | none | 0 | — |
| hooks/useKeyboardShift.ts | 43 | no | 1 | none | 0 | — |
| utils/projectColor.ts | 39 | no | 2 | none | 0 | — |
| utils/paste.ts | 39 | no | 3 | none | 0 | No header comment |
| utils/worktreeDestination.ts | 36 | no | 2 | none | 0 | — |
| utils/chatArchive.ts | 30 | no | 2 | none | 0 | — |
| hooks/useOnClickOutside.ts | 30 | no | 1 | none | 0 | No header comment |
| hooks/useMobileLayout.ts | 29 | no | 1 | none | 0 | No header comment |
| hooks/useEscapeToClose.ts | 25 | no | 1 | none | 0 | No header comment |
| hooks/useStableValue.ts | 24 | no | 2 | none | 0 | — |
| utils/sortableTransform.ts | 22 | no | 2 | none | 0 | No header comment |
| utils/copyText.ts | 19 | no | 1 | none | 0 | — |
| utils/time.ts | 15 | no | 1 | none | 0 | No header comment |
| utils/cn.ts | 10 | no | 1 | none | 0 | No header comment |
| utils/sessionId.ts | 5 | no | 1 | none | 0 | No header comment |

TODO/FIXME/HACK/XXX: 0 in every in-scope file.

Header-comment status: files marked "no header comment" start directly with imports; none of the files with headers were STALE — every header found matched current content (useWebSocket.ts, sound.ts, a11yRowStability.ts, useVisualViewport.ts, workspaceView.ts, workspaceStore.ts, updateStore.ts, chatStore.ts, chatArchive.ts, chatWireFrames.ts, worktreeDestination.ts, browserFiles.ts, useKeyboardShift.ts, useStableValue.ts, projectColor.ts, copyText.ts, settingsStore partial note only). useTerminal.ts, App.tsx, sessionStore.ts, themeStore.ts have no file header comment.

## Section 2: Files over 500 LOC

### hooks/useTerminal.ts (2016 LOC)
No file header comment (first comment, line 19, describes the module-level snapshot cache only).
Exports (6): `invalidateSnapshotCache` — remove one session's cached serialized terminal snapshot; `clearSnapshotCache` — clear all cached snapshots (on reconnect); `resetDroppedOutputRateLimiterForTests` — test-only limiter/clock reset; `sanitizeLink` — trim trailing punctuation/unbalanced brackets from link text; `forceTextPresentation` — append VS15 to iOS emoji-rendered glyphs; `useTerminal` — the hook: creates/manages the xterm instance, addons, attach/detach lifecycle, paste (text/image/file), tmux copy-mode wheel handling, output buffering with write backpressure, and iOS repaint/WebGL recovery.

Long functions:
- `useTerminal` 333–2016 (~1683 lines), containing: mount/init effect 609–1236 (~627) including an inline ~195-line paste-resolution block (858–1062); attach/detach/session-switch effect 1328–1561 (~233); output-subscriber effect 1586–1863 (~277); iOS visibility/pageshow/focus effect 1904–1991 (~87).

Duplicated logic within the file:
- WebglAddon creation with `onContextLoss` dispose: 673–685 (openTerminal), 1282–1294 (runtime toggle effect), 1941–1948 (recreateWebGLIfNeeded) — three near-identical blocks.
- Detach-state reset (clear attachedSessionRef / attachedTargetRef / attachedConnectionEpochRef / focusAfterAttachSessionRef, optionally setTmuxCopyMode(false)): 1341–1348, 1364–1371, 1397–1403, 1541–1545 — four copies.
- `tmux-cancel-copy-mode` send + `setTmuxCopyMode(false)` pair: 850–853, 899–902, 1024–1027, 1112–1115 — four copies.
- Clipboard write with clientLog success/failure pair: `SafeClipboardProvider.writeText` 254–277 and clipboard-offer handler 1808–1828.
- `/api/clipboard-file-path` fetch + `{path, isImage}` parsing: `fetchClipboardImagePath` 138–148 and inline repeat at 989–1005.

### App.tsx (1351 LOC)
No file header comment.
Exports (1): `App` (default) — root component: store wiring, WebSocket message routing, keyboard shortcuts, modal/branch-browser state, layout render.

Long components:
- `App` 65–1351 (~1286 lines); its WebSocket subscribe effect 214–596 (~382 lines) handles ~25 message types in one closure; keyboard-shortcut effect 972–1070 (~99).

Duplicated logic within the file:
- Status-transition sound logic duplicated: `sessions` handler 222–237 vs `session-update` handler 380–400 (same prev/next status comparisons + playPermissionSound/playIdleSound).
- `create-worktree` vs `create-change-worktree` result handling 327–349 vs 351–369 — near-identical pending-ref match / open modal / error-toast blocks.
- `setServerError(...)` + `window.setTimeout(() => setServerError(null), 6000)` pattern repeated 7 times (348, 367, 512, 523, 529, 539, 566, 571).
- Filter-then-select-first-visible fallback logic appears in several effects (813–830, 832–868, 870–901, 903–922) around `selectFirstVisibleTarget`.

### hooks/useWebSocket.ts (753 LOC)
Header comment present (lines 1–31, iOS PWA resume strategy) — accurate, matches content.
Exports (2): `WebSocketManager` — class owning the socket: connect/backoff, connect-timeout guard, heartbeat ping/pong with seq matching, resume verify-then-reconnect, time-jump detector, leaked-socket purge, message/status listener registries; `useWebSocket` — React binding: singleton manager connect/lifecycle on mount, status→sessionStore bridge, stable `sendMessage`/`subscribe`/`getConnectionEpoch`.

Long functions: `WebSocketManager` class 103–713 (~610); `connect()` 148–285 (~137) including five inline socket handlers.

Duplicated logic: none significant (timer cleanup helpers are factored: clearConnectTimer/clearPongTimer/cancelVerify).

### stores/settingsStore.ts (508 LOC)
No file header comment (line 8 comment covers only DEFAULT_PROJECT_DIR).
Exports (~29): `FontOption`, `FONT_OPTIONS`, `getFontFamily` — terminal font config; `SessionSortMode`, `SessionSortDirection`, `ShortcutModifier`, `CommandPreset`, `DEFAULT_PRESETS` — setting types/defaults; `isValidPreset`, `normalizePreset`, `getFullCommand`, `generatePresetId`, `resolveDefaultPresetId` — preset validation/normalization helpers; `useSettingsStore` — persisted zustand store (~70 fields+setters: project dir, sort, fonts, sizes, modifiers, toggles, pane fractions, filters, sounds, presets); 13 re-exported constants (`DEFAULT_PROJECT_DIR`, `LEGACY_DEFAULT_PROJECT_DIR`, `DEFAULT_COMMAND`, `MAX_PRESETS`, `SIDEBAR_*`, `PANE_*`, `CHAT_FONT_SIZE_*`); `useSettingsHasHydrated` — post-hydration gate hook.

Long functions: `migrate()` 358–471 (~113) — v0→v7 preset migration, validation, re-clamping.

Duplicated logic within the file:
- SettingsState interface 149–222 (~74 lines) mirrors the create() block 226–333 field-for-field; every persisted field costs an interface line, a setter declaration, and a set() line (~25 fields).
- The export block 476–489 re-exports constants already defined locally — two names for each.

## Section 3: Files under 500 LOC

Store importer counts (`grep -rn "from .*stores/<name>" src`, non-test importers in parens):
- stores/settingsStore.ts — 28 importers (18 non-test) — flagged: imported nearly everywhere (App, 9 components, 2 hooks, 2 utils).
- stores/sessionStore.ts — 18 importers (10 non-test) — flagged: broad reach (App, 5 components, 2 hooks).
- stores/themeStore.ts — 7 (6 non-test).
- stores/chatDebugStore.ts — 5 (3 non-test).
- stores/updateStore.ts — 5 (3 non-test).
- stores/chatStore.ts — 4 (2 non-test).
- stores/workspaceStore.ts — 2 (1 non-test).

Per-file one-liners:
- utils/workspaceView.ts (347) — header ok; 9 exports; `buildWorkspaceView` is 170–347 (~177 lines); no TODOs.
- stores/sessionStore.ts (270) — no header comment; 2 exports (`ConnectionStatus`, `useSessionStore`); store creation block 103–270 (~167 lines) with inline equality helpers; 10 non-test importers.
- utils/sound.ts (214) — header ok; 4 exports; no function >100 lines; note: wake-detection listeners + 5s interval installed at import time (63–90); minor duplication of rate-limit+playTone wrapper in playPermissionSound/playIdleSound (174–191, 197–214).
- hooks/useVisualViewport.ts (193) — header ok; 3 exports; `useVisualViewport` mount effect 72–192 (~120 lines) wiring 6 listeners, rAF burst, 250ms polling; no TODOs.
- stores/chatStore.ts (175) — header ok; 5 exports (emptyTranscript, applyChatEvents, useChatStore, +2 types); pure reducer split out of the store; no TODOs; 2 non-test importers.
- utils/sessions.ts (140) — no header comment; 5 exports (SortOptions, getSessionOrderKey, sortSessions, getUniqueProjects, getUniqueHosts).
- utils/a11yRowStability.ts (135) — header ok; 1 export (keepA11yRowsStable); intentional xterm prototype patching for iOS a11y.
- stores/workspaceStore.ts (116) — header ok; 1 export (useWorkspaceStore); only 1 non-test importer.
- utils/storage.ts (107) — no header comment; 2 exports (safeStorage, createTabStorage).
- utils/chatWireFrames.ts (100) — header ok; 7 exports (parseFrame, frameLabel, prettyFrame, DIRECTION_LABELS, groupFrames, frameTime, FrameEntry).
- hooks/useBrowserPaste.ts (92) — header ok; 3 exports (BrowserPaste, PasteState, useBrowserPaste).
- utils/sessionLabel.ts (88) — no header comment; 3 exports (formatCommandLabel, getPathLeaf, getDisambiguatedProjectNames).
- stores/chatDebugStore.ts (81) — header ok; 6 exports (MAX_DEBUG_FRAMES, closedDebugView, mergeFrames, applyDebugFrames, useChatDebugStore, +1); 3 non-test importers.
- stores/themeStore.ts (78) — no header comment; 3 exports (Theme, useThemeStore, terminalThemes); 6 non-test importers.
- hooks/useEdgeSwipeToOpenDrawer.ts (76) — no header comment; 1 export.
- utils/device.ts (75) — no header comment; 9 exports (device detection + modifier matching helpers).
- utils/browserFiles.ts (64) — header ok; 5 exports (clipboardFiles, validateFiles, uploadBrowserFile, quotedFilePath, readBrowserClipboard).
- hooks/useExitCleanup.ts (58) — no header comment; 1 export.
- utils/clientLog.ts (46) — no header comment; 2 exports.
- stores/updateStore.ts (44) — header ok; 2 exports (UpdateStore, useUpdateStore); 3 non-test importers.
- main.tsx (44) — no header comment; 0 exports; iOS class setup + PWA service-worker registration + root render.
- hooks/useCounterBump.ts (44) — no header comment; 1 export.
- hooks/useKeyboardShift.ts (43) — header ok (one-liner); 1 export.
- utils/projectColor.ts (39) — header ok; 2 exports (getProjectColorStyle, getProjectHue).
- utils/paste.ts (39) — no header comment; 3 exports (bracketedPaste, sanitizeImagePath, imagePathInput).
- utils/worktreeDestination.ts (36) — header ok; 2 exports.
- utils/chatArchive.ts (30) — header ok; 2 exports.
- hooks/useOnClickOutside.ts (30) — no header comment; 1 export.
- hooks/useMobileLayout.ts (29) — no header comment; 1 export (useIsMobileLayout).
- hooks/useEscapeToClose.ts (25) — no header comment; 1 export.
- hooks/useStableValue.ts (24) — header ok; 2 exports.
- utils/sortableTransform.ts (22) — no header comment; 2 exports.
- utils/copyText.ts (19) — header ok; 1 export.
- utils/time.ts (15) — no header comment; 1 export (formatRelativeTime).
- utils/cn.ts (10) — no header comment; 1 export (cn).
- utils/sessionId.ts (5) — no header comment; 1 export (getSessionIdShort).
