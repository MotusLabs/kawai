import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const skipIsolated = args.includes('--skip-isolated')
const skipRealTmux = args.includes('--skip-real-tmux')
const passthroughArgs = args.filter(
  (arg) => arg !== '--skip-isolated' && arg !== '--skip-real-tmux'
)

function createTempLogDirs() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-tests-'))
  const claudeDir = path.join(tempRoot, 'claude')
  const codexDir = path.join(tempRoot, 'codex')
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true })
  return { tempRoot, claudeDir, codexDir }
}

async function runCommand(cmd: string[], env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn({
    cmd,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}`)
  }
}

async function main() {
  const { tempRoot, claudeDir, codexDir } = createTempLogDirs()
  const tempLogFile = path.join(tempRoot, 'agentboard.log')
  const tempDbPath = path.join(tempRoot, 'agentboard.db')
  const env = {
    ...process.env,
    // React's act() requires the development build; force NODE_ENV=test
    // so tests pass even when the shell has NODE_ENV=production.
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV || 'test'),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    LOG_FILE: tempLogFile,
    AGENTBOARD_DB_PATH: tempDbPath,
    // Default skipMatchingPatterns excludes /tmp/* and /var/folders/* — both
    // common locations for test working directories (worktrees, CI runners on
    // some platforms). Tests that exercise matching logic from those paths
    // would otherwise be silently skipped. Tests that need specific skip
    // behavior pass patterns explicitly via the matcher API.
    AGENTBOARD_SKIP_MATCHING_PATTERNS: '',
  }

  try {
    // Tests that either mutate globals or are sensitive to global mutations
    // must run in a separate process so they don't race with other test files.
    // PipePaneTerminalProxy reads Bun.spawnSync at construction time — if another
    // test file has patched it, the proxy gets a mock and start() becomes undefined.
    // hydrateSessionsEmptyGuard imports `../index` with an active Bun.spawnSync /
    // Bun.serve / setInterval mock; isolation keeps that mock window from
    // overlapping with any other test that captures globals at module load.
    const ISOLATED_FILES = new Set([
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
    const ISOLATED_REAL_TMUX_FILES = new Set([
      'copy-mode-async.integration.test.ts',
      'output-coalescing.integration.test.ts',
      'double-attach.integration.test.ts',
      'hibernation.integration.test.ts',
      'integration.test.ts',
      'throttled-reconnect.integration.test.ts',
    ])

    // Client tests that install top-level mock.module(...) hooks must run in a
    // separate process — Bun's module mocks persist for the lifetime of the
    // test process, so they leak into any subsequent file that imports the
    // same module. (app.test.tsx used to stub ../components/SessionPreviewContent
    // here; the stub is gone, but its useWebSocket/xterm mocks keep it in this
    // set.)
    const ISOLATED_CLIENT_FILES = new Set([
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

    const serverTests: string[] = []
    const serverGlob = new Bun.Glob('src/server/__tests__/*.test.ts')
    for await (const file of serverGlob.scan({ onlyFiles: true })) {
      const basename = path.basename(file)
      if (!ISOLATED_FILES.has(basename) && !ISOLATED_REAL_TMUX_FILES.has(basename)) {
        serverTests.push(file)
      }
    }

    const clientTests: string[] = []
    const clientGlob = new Bun.Glob('src/client/__tests__/*.test.{ts,tsx}')
    for await (const file of clientGlob.scan({ onlyFiles: true })) {
      if (!ISOLATED_CLIENT_FILES.has(path.basename(file))) {
        clientTests.push(file)
      }
    }
    const sharedTestsDir = 'src/shared/__tests__'

    await runCommand(
      ['bun', 'test', ...passthroughArgs, ...serverTests, sharedTestsDir, ...clientTests],
      env
    )

    // Always run global-mutating tests in a separate process to prevent races.
    // Each file runs in its own bun process — isolation is from every other
    // file, not just from the main suite. terminalProxyFactory.test.ts
    // installs mock.module('../terminal/PipePaneTerminalProxy', ...) that
    // would otherwise leak into pipePaneTerminalProxy.test.ts on readdir
    // orderings where it loads first (Linux ext4).
    for (const file of ISOLATED_FILES) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, `src/server/__tests__/${file}`],
        env
      )
    }

    if (!skipRealTmux) {
      const argsWithoutCoverage = stripCoverageArgs(passthroughArgs)
      for (const file of ISOLATED_REAL_TMUX_FILES) {
        await runCommand(
          ['bun', 'test', ...argsWithoutCoverage, `src/server/__tests__/${file}`],
          env
        )
      }
    }

    for (const file of ISOLATED_CLIENT_FILES) {
      await runCommand(
        ['bun', 'test', ...passthroughArgs, `src/client/__tests__/${file}`],
        env
      )
    }

    if (!skipIsolated) {
      // Each file in isolated/ runs in its own process, same as ISOLATED_FILES
      // above: these files install top-level mock.module(...) hooks (e.g.
      // indexHandlers.test.ts stubs ../../terminal with a partial factory),
      // and Bun module mocks persist for the life of the process — on readdir
      // orderings where the mocking file loads first (Linux ext4), a shared
      // process poisons every later import of the same module.
      const isolatedTests: string[] = []
      const isolatedGlob = new Bun.Glob('src/server/__tests__/isolated/*.test.ts')
      for await (const file of isolatedGlob.scan({ onlyFiles: true })) {
        isolatedTests.push(file)
      }
      isolatedTests.sort()
      for (const file of isolatedTests) {
        await runCommand(['bun', 'test', ...passthroughArgs, file], env)
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

function stripCoverageArgs(args: string[]) {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--coverage') continue
    if (arg.startsWith('--coverage=')) continue
    if (arg.startsWith('--coverage-reporter=')) continue
    if (arg === '--coverage-reporter') {
      index += 1
      continue
    }
    stripped.push(arg)
  }
  return stripped
}
