# Kawai — Phase 1 Cross-Cutting Static Checks

Repo: /home/coder/kawai. Production code = everything under src/ except `__tests__` directories.

## 1. Shared Types (src/shared/)

| File | LOC | Exported type/interface | Server importers (files / import stmts) | Client importers (files / import stmts) |
|---|---|---|---|---|
| types.ts | 415 | 26 | 22 / 24 | 34 / 34 |
| chat.ts | 309 | 25 | 14 / 15 | 13 / 13 |
| dependencyRisk.ts | 466 | 10 | 0 / 0 | 0 / 0 |
| workspace.ts | 232 | 10 | 9 / 9 | 7 / 7 |
| eventTaxonomy.ts | 396 | 6 | 1 / 1 | 1 / 1 |
| chatProviderSettings.ts | 20 | 3 | 1 / 1 | 1 / 1 |
| workspaceValidation.ts | 287 | 2 | 4 / 4 | 1 / 1 |
| activityBucket.ts | 23 | 0 (value exports) | 1 / 1 | 1 / 1 |
| agentToken.ts | 124 | 0 (value exports) | 1 / 2 | 1 / 1 |
| devProxyErrors.ts | 40 | 0 | 0 / 0 | 0 / 0 |
| json.ts | 12 | 0 | 0 / 0 | 1 / 1 |
| pasteFiles.ts | 3 | 0 | 1 / 1 | 1 / 1 |

Notes:
- Import syntax differs per side: server uses relative `../shared/x`, client uses the `@shared/x` alias.
- `dependencyRisk.ts` (466 LOC) and `devProxyErrors.ts` (40 LOC) are imported by neither src/server nor src/client production code. Neither is dead: `devProxyErrors.ts` is imported by the root `vite.config.ts` (outside this grep), so root-level config files must be searched before declaring a src/shared module unused.

## 2. Layering Violations

- client → server: **0 hits** (`grep -rn "from ['\"].*server/" src/client`, tests excluded). Clean.
- server → client: **0 hits** (`grep -rn "from ['\"].*client/" src/server`, tests excluded). Clean.

## 3. Suspicious Import Patterns

### 15 largest production files — internal src imports (module names only)

| File | LOC | Internal imports |
|---|---|---|
| src/server/index.ts | 4948 | routes/claudeProfiles, config, routes/pasteFile, routes/chatProviderEnv, prerequisites, SessionManager, SessionRegistry, version, updates/updateChecker, updates/updateInstaller, updates/updateRestart, db, logPoller, agentSessions, chat/ChatSessionManager, chat/ChatConnections, chat/ChatWireLogs, chat/developmentFixture, chat/approvalPolicy, logDiscovery, logMatcher, terminal (x2), terminal/outputCoalescer, sessionWake/rematchTarget, paths, shared/types (x2), logger, sessionRefreshWorkerClient, forceWorkingStatus, tmuxTimeout, validators, shared/workspaceValidation, shared/workspace, git/repositoryResolution, git/createWorktree, git/createChangeWorktree, workspace/workspaceCoordinator, workspace/workspaceWatcher, applyCommand, remoteSessions, agentDetection, nameGenerator, shellQuote, terminal/SshTerminalProxy, terminal/tmuxText, tmuxFormat |
| src/server/logMatcher.ts | 2599 | shared/eventTaxonomy, shared/types, agentDetection, logDiscovery, terminal/tmuxText, logger, tmuxFormat |
| src/client/hooks/useTerminal.ts | 2016 | shared/types, utils/clientLog, stores/sessionStore, stores/settingsStore, utils/copyText, utils/device (x2), utils/paste, utils/browserFiles |
| src/client/components/Terminal.tsx | 1768 | shared/types, utils/clientLog, stores/sessionStore, hooks/useTerminal, hooks/useMobileLayout, hooks/useOnClickOutside, hooks/useEscapeToClose, hooks/useEdgeSwipeToOpenDrawer, stores/themeStore, stores/settingsStore, utils/device, utils/a11yRowStability, utils/time, utils/sessionLabel, hooks/useStableValue, TerminalControls, PasteStatus, hooks/useBrowserPaste, utils/browserFiles, SessionDrawer, utils/workspaceView, SessionPreviewContent |
| src/client/App.tsx | 1351 | shared/types, shared/workspace, components/Header, SessionList, Terminal, chat/ChatView, stores/chatStore, chatDebugStore, updateStore, NewSessionModal, BranchBrowserModal, CreateWorktreeModal, SettingsModal, UpdatePanel, Toast, sessionStore, settingsStore, themeStore, workspaceStore, hooks/useWebSocket, useTerminal, useVisualViewport, utils/sessions, workspaceView, chatArchive, clientLog, device, sound |
| src/server/logPoller.ts | 1224 | logger, config, db, logDiscovery, agentDetection, logMatcher, agentSessions, nameGenerator, SessionRegistry, logMatchWorkerClient, logWatcher, shared/types (x2), logPollData, logMatchGate, logMatchWorkerTypes |
| src/server/chat/ChatSessionManager.ts | 1221 | shared/chat, shared/types, db, nameGenerator, paths, SessionRegistry, ChatSessionDriver, chatAuth, claudeExecutable, chatProviderEnv, ChatWireLogs, ClaudeProfiles, logger, sdkAvailability, usageLimits, transcriptReplay, transcriptTitleWatcher |
| src/server/SessionManager.ts | 1184 | agentDetection, config, displayName, logDiscovery, nameGenerator, logger, paths, tmuxTimeout, tmuxEnv, tmuxFormat, statusInference (x2), shared/types |
| src/server/db.ts | 1162 | shared/chat, shared/types, chat/approvalPolicy, nameGenerator, paths |
| src/server/chat/ChatSessionDriver.ts | 1108 | shared/chat, shared/types, contentBlocks, chatActivity, contextUsage, usageLimits, chatProviderEnv, chatCommands, approvalPolicy, ClaudeProfiles, TurnQueue, wireTap |
| src/client/components/SessionList.tsx | 928 | utils/sessions, utils/time, stores/settingsStore, stores/sessionStore, utils/device, hooks/useCounterBump, useExitCleanup, useStableValue, HostFilterDropdown, ProjectFilterDropdown, SessionPreviewModal, HibernatingSessionItem, HistorySessionItem, SessionRow, WorkspaceSectionList, utils/workspaceView |
| src/server/terminal/PtyTerminalProxy.ts | 892 | TerminalProxyBase, types, groupedSessionTarget, tmuxFormat, tmuxEnv |
| src/client/components/SessionPreviewContent.tsx | 877 | Markdown |
| src/client/components/SessionRow.tsx | 768 | utils/time, sessionLabel, sessionId, copyText, sortableTransform, AgentIcon, ProjectBadge, HostBadge |
| src/client/hooks/useWebSocket.ts | 753 | stores/sessionStore (x2), utils/clientLog |

### Circular dependency candidates

Checked all reverse edges among the 15 largest files and their common dependencies (sessionStore, settingsStore, TerminalProxyBase, ChatSessionDriver↔Manager, logMatcher↔logPoller, SessionRow↔SessionList, Markdown↔SessionPreviewContent, wireTap, agentDetection, logDiscovery, paths, SessionRegistry, db, WorkspaceSectionList). **No pair imports each other. 0 circular pairs found.**

### src/server/index.ts importers

**0 files** import `server/index` anywhere in src (including tests). It is a pure entry point; not a god-module-by-import, though at 4,948 LOC with 46 internal import statements it is the largest file and widest consumer in the codebase.

## 4. TODO/FIXME/HACK Inventory

Production code (src excluding `__tests__`): **0 hits** for `\bTODO\b|\bFIXME\b|\bHACK\b`.
The only case-insensitive near-miss is a grep-pattern literal, not a comment:

- src/server/terminal/tmuxText.ts:16 — `/todos?\b/i,` (regex matching Claude todo lines)

Whole src including tests: 2 additional hits, both test fixture strings in `src/client/__tests__/toolCallLabel.test.ts` (lines 13, 66) exercising the tool-label rendering of a "TODO" pattern and `TodoWrite`.

## 5. Test Organization Smells

- Test directories: `src/server/__tests__` (+ `isolated/`, `fixtures/`), `src/client/__tests__`, `src/shared/__tests__`. All 168 test files live under `__tests__`; no stray `*.test.*` files elsewhere.
- Numbered / order-forcing test files: **1** — `src/server/__tests__/01-sessionRegistry.test.ts` (no 02+ exists; the numbering is vestigial).
- Test files over 1000 LOC (14 files; 14 files over 800 LOC):

| File | LOC |
|---|---|
| src/server/__tests__/isolated/indexHandlers.test.ts | 7093 |
| src/client/__tests__/useTerminal.test.tsx | 5046 |
| src/server/__tests__/chatSessionManager.test.ts | 3006 |
| src/client/__tests__/app.test.tsx | 2395 |
| src/server/__tests__/sessionManager.test.ts | 2290 |
| src/server/__tests__/chatSessionDriver.test.ts | 2275 |
| src/server/__tests__/logMatcher.test.ts | 2184 |
| src/server/__tests__/logPoller.test.ts | 2065 |
| src/client/__tests__/websocketManager.test.ts | 1589 |
| src/client/__tests__/newSessionModal.test.tsx | 1480 |
| src/server/__tests__/isolated/terminalProxy.test.ts | 1472 |
| src/client/__tests__/chatComponents.test.tsx | 1456 |
| src/client/__tests__/terminal.test.tsx | 1128 |
| src/client/__tests__/sessionListGrouped.test.tsx | 1102 |

- Duplicated helper utilities: **none found.** Only two non-test helper files exist across all test dirs, each unique: `src/server/__tests__/testEnvironment.ts` and `src/server/__tests__/fixtures/claudeCommands.ts`. No same-named helpers under different `__tests__` dirs.
- Integration tests use a `.integration.test.ts` suffix in `src/server/__tests__` (4 files: output-coalescing, slug-supersede, throttled-reconnect, updateFlow).

## 6. Typo/Consistency: "agentboard" vs "kawai" (src, tests excluded)

- `agentboard` (case-insensitive): **146 hits**
- `kawai` (case-insensitive): **33 hits**

The minority naming is `kawai`. All 33 hits:

1. src/server/git/createChangeWorktree.ts:299 — `identityArgs.push('-c', 'user.name=Kawai')`
2. src/server/git/createChangeWorktree.ts:302 — `identityArgs.push('-c', 'user.email=kawai@localhost')`
3. src/server/chat/claudeExecutable.ts:5 — comment: KAWAI_CLAUDE_PATH resolution
4. src/server/chat/claudeExecutable.ts:41 — error text: `or set KAWAI_CLAUDE_PATH to the executable.`
5. src/server/chat/claudeExecutable.ts:44 — doc comment (KAWAI_CLAUDE_PATH)
6. src/server/chat/claudeExecutable.ts:52 — `env.KAWAI_CLAUDE_PATH`
7. src/server/chat/claudeExecutable.ts:114 — error text (KAWAI_CLAUDE_PATH)
8. src/server/chat/claudeExecutable.ts:143 — error text (KAWAI_CLAUDE_PATH)
9. src/server/chat/profileCatalog.ts:1 — comment (`.kawai/profiles.json`)
10. src/server/chat/profileCatalog.ts:3 — comment (`~/.kawai/profiles.json`)
11. src/server/chat/profileCatalog.ts:37 — doc comment (`~/.kawai/profiles.json`)
12. src/server/chat/profileCatalog.ts:117 — error text (`~/.kawai/profiles.json`)
13. src/server/chat/profileCatalog.ts:175 — doc comment (`.kawai/profiles.json`)
14. src/server/chat/profileCatalog.ts:184 — `path.join(path.sep, '.kawai', 'profiles.json')`
15. src/server/chat/profileCatalog.ts:186 — same `.kawai` path join
16. src/server/chat/profileCatalog.ts:193 — doc comment (`.kawai`)
17. src/server/chat/profileCatalog.ts:203 — `path.join(home, '.kawai', 'profiles.json')`
18. src/server/chat/usageLimits.ts:4 — comment ("Kawai-owned ChatUsageReport")
19. src/server/chat/ChatSessionManager.ts:13 — comment (KAWAI_CLAUDE_PATH)
20. src/server/chat/ChatSessionManager.ts:104 — doc comment (KAWAI_CLAUDE_PATH)
21. src/server/chat/ChatSessionManager.ts:119 — doc comment (`~/.kawai/profiles.json`)
22. src/server/updates/releaseFeed.ts:2 — comment ("kawai repository")
23. src/server/updates/releaseFeed.ts:36 — comment (KAWAI_UPDATE_ENDPOINT)
24. src/server/updates/releaseFeed.ts:37 — comment (KAWAI_BUILD_VERSION)
25. src/server/updates/releaseFeed.ts:39 — `process.env.KAWAI_UPDATE_ENDPOINT`
26. src/server/updates/updateConstants.ts:6 — `RELEASE_REPO = 'MotusLabs/kawai'`
27. src/server/version.ts:28 — `process.env.KAWAI_BUILD_VERSION`
28. src/server/routes/claudeProfiles.ts:2 — comment (`.kawai`)
29. src/client/components/NewSessionModal.tsx:124 — comment (`.kawai`)
30. src/client/components/chat/useClaudeProfiles.ts:1 — comment (`.kawai`)

(plus 3 more client hits: Header.tsx:54/56 "Kawai v/KAWAI" title text, UpdatePanel.tsx:89 "Kawai" label)

Caveat: this is a mixed-rename state, not stray typos — `agentboard` dominates as env-var prefix (`AGENTBOARD_STATIC_DIR`, `AGENTBOARD_CHAT_ENV`, …), the DB name (`agentboard.db`), and the `bin/agentboard` launch chain, while `kawai` survives as the `KAWAI_*` env prefix, `.kawai` config dirs, git identity, GitHub repo, and UI titles.

## 7. Dependency Surface

package.json: **27 runtime dependencies, 17 devDependencies.**

Production import counts per runtime dep (src excluding `__tests__`):

| Imports | Dependency |
|---|---|
| 0 | @fontsource-variable/jetbrains-mono |
| 0 | node-pty |
| 1 | clsx, @dnd-kit/utilities, pino, react-markdown, remark-breaks, remark-gfm, tailwind-merge, @xterm/addon-clipboard, @xterm/addon-fit, @xterm/addon-progress, @xterm/addon-search, @xterm/addon-serialize, @xterm/addon-webgl, @xterm/addon-web-links |
| 2 | @base-ui/react, @xterm/xterm |
| 3 | @dnd-kit/core, react-dom |
| 4 | @dnd-kit/sortable, motion |
| 5 | @anthropic-ai/claude-agent-sdk, hono |
| 12 | zustand |
| 45 | @untitledui-icons/react |
| 48 | react |

Flagged (imported 0 times across src):
- **node-pty** — zero imports anywhere in the repo (src, scripts, configs). The terminal layer is entirely tmux-based; the dependency appears only in package.json (and historical planning notes under `.pl4n/`).
- **@fontsource-variable/jetbrains-mono** — never imported; the JetBrains Mono woff2 is served directly from `public/fonts/` via `<link rel="preload">` in index.html, bypassing the package.
