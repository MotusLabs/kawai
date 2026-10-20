// Hand-kept isolation lists (design D1): files that ran one process at a
// time because Bun's shared test process leaked module mocks and global
// patches between files. Task 2.4 deletes this module once every entry has
// passed inside the parallel run, so keeping the lists alone in one file
// makes that removal a single delete.

// Tests that either mutate globals or are sensitive to global mutations
// must run in a separate process so they don't race with other test files.
// PipePaneTerminalProxy reads Bun.spawnSync at construction time — if another
// test file has patched it, the proxy gets a mock and start() becomes undefined.
// hydrateSessionsEmptyGuard imports `../index` with an active Bun.spawnSync /
// Bun.serve / setInterval mock; isolation keeps that mock window from
// overlapping with any other test that captures globals at module load.
export const ISOLATED_FILES = new Set([
  // Entry-point tests patch Bun.serve/Bun.spawnSync/process.exit while
  // importing the server. Keep them away from real server/tmux tests.
  'directories.test.ts',
  'index.test.ts',
  'indexPortCheck.test.ts',
  'slug-supersede.integration.test.ts',
  'sessionRefreshWorker.test.ts',
  'pipePaneTerminalProxy.test.ts',
  'hydrateSessionsEmptyGuard.test.ts',
  // terminalProxyFactory.test.ts installs a top-level
  // mock.module('../config', ...) whose replacement omits many real
  // config fields. Bun's mock.restore() in afterAll does not fully
  // unwind module-level mocks, so the stripped config can leak into
  // any later test file that imports `../config` (notably
  // logPoller.test.ts, which depends on skipMatchingPatterns).
  'terminalProxyFactory.test.ts',
])

// These spawn real servers, PTYs, and tmux clients. They still need process
// isolation from global Bun.* mocks, but running them under coverage on
// Linux CI can stall PTY attach readiness.
export const REAL_TMUX_FILES = new Set([
  'copy-mode-async.integration.test.ts',
  'output-coalescing.integration.test.ts',
  'double-attach.integration.test.ts',
  'hibernation.integration.test.ts',
  'integration.test.ts',
  'throttled-reconnect.integration.test.ts',
  'chatRename.integration.test.ts',
])

// Client tests that install top-level mock.module(...) hooks must run in a
// separate process — Bun's module mocks persist for the lifetime of the
// test process, so they leak into any subsequent file that imports the
// same module. (app.test.tsx used to stub ../components/SessionPreviewContent
// here; the stub is gone, but its useWebSocket/xterm mocks keep it in this
// set.)
export const ISOLATED_CLIENT_FILES = new Set([
  'app.test.tsx',
  // Files that render motion/react (framer-motion) components. The
  // library keeps module-level projection state (a root node per
  // document) and schedules async frame callbacks on the global rAF;
  // both leak across files sharing a process. A leaked frame callback
  // firing after a file restored its window stub crashes with
  // "undefined is not an object (evaluating 'window.innerWidth')"
  // between tests, and the corrupted frameloop then fails unrelated
  // tests in later files (seen on Linux CI as useTerminal/SessionDrawer
  // failures; order- and timing-dependent, so macOS rarely hits it).
  'renderComponents.test.tsx',
  'sessionListComponent.test.tsx',
  'sessionDrawer.test.tsx',
  'sessionListFilters.test.tsx',
  // Grouped-navigator tests render SessionList (framer-motion) with the
  // same window-stub pattern; same isolation requirement as above.
  'sessionListGrouped.test.tsx',
  // Same: drives the shipped SessionList (flat and grouped) to lock the
  // killed-row unmount contract.
  'sessionRowExit.test.tsx',
  'SectionHeader.test.tsx',
  // The grouped navigator also puts motion components into whole-app and
  // Terminal renders: main.test.ts mounts the full App (SessionList),
  // and terminal.test.tsx opens the mobile drawer (SessionDrawer). Same
  // leak class — saw CI fail with 'window.addEventListener is not a
  // function' from a motion frame callback after another file restored
  // its window stub.
  'main.test.ts',
  'terminal.test.tsx',
  // More top-level mock.module(...) installers from the terminal-lag
  // change. useTerminal.test.tsx stubs ../utils/clientLog — on Linux CI
  // (bun 1.3.14) the stub leaked into clientLog.test.ts when readdir
  // order loaded useTerminal first: setClientLogLevel became a no-op and
  // every fetch-expecting assertion saw zero calls. sessionRowMemo and
  // terminalControls stub ../utils/time and ../utils/device, which wider
  // test files also import — same leak class, isolated preemptively.
  // (Not reproducible off the runner: same bun build, file order, and
  // core count pass locally, matching the order-dependent leaks above.)
  'useTerminal.test.tsx',
  'sessionRowMemo.test.tsx',
  'terminalControls.test.tsx',
])
