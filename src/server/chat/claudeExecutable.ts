// Claude Code executable selection for chat sessions. The Agent SDK's
// bundled platform CLIs are not installed (package.json overrides map them
// to an empty stub), so every chat spawn and availability probe runs a
// separately installed `claude` through the SDK's pathToClaudeCodeExecutable
// option. Resolution is server-only (KAWAI_CLAUDE_PATH, else `claude` on
// PATH); the value is always a single executable path — never split or
// passed to a shell. A successful version check is cached per path/realpath/
// mtime so an upgrade in place re-checks; failures are never cached, so an
// installed or repaired executable recovers without a server restart.
import fs from 'node:fs'
import path from 'node:path'

/**
 * Minimum Claude Code version chat sessions support. Must stay equal to the
 * SDK's `claudeCodeVersion` (pinned by test) so an SDK upgrade forces a
 * deliberate baseline update: the SDK protocol pairs with that CLI build.
 */
export const CLAUDE_CODE_MIN_VERSION = '2.1.289'

/** Default bound for the `--version` probe. */
export const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 10_000

export type ClaudeExecutableErrorKind =
  | 'missing'
  | 'not-executable'
  | 'unsupported'
  | 'probe-failed'

export class ClaudeExecutableError extends Error {
  readonly kind: ClaudeExecutableErrorKind
  constructor(kind: ClaudeExecutableErrorKind, message: string) {
    super(message)
    this.name = 'ClaudeExecutableError'
    this.kind = kind
  }
}

/** Where to find Claude Code and what to do when it is absent. */
const INSTALL_HINT =
  'Install Claude Code (https://claude.com/claude-code) so `claude` is on the server PATH, ' +
  'or set KAWAI_CLAUDE_PATH to the executable.'

/**
 * Resolve the executable chat sessions will run: the trimmed KAWAI_CLAUDE_PATH
 * value when non-empty, otherwise `claude` from PATH. Returns null when
 * neither yields a path. The value is one path (never split or run by a
 * shell), made absolute against the server working directory.
 */
export function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env
): string | null {
  const configured = (env.KAWAI_CLAUDE_PATH ?? '').trim()
  // Absolute against the server's working directory: verification runs here,
  // but the SDK spawns from each project directory, where a relative path
  // would name a different (or no) file.
  if (configured) return path.resolve(configured)
  const found = Bun.which('claude', { PATH: env.PATH ?? '' })
  return found ? path.resolve(found) : null
}

/** A verified executable: the path to run and its change identity. */
export interface ClaudeExecutableCheck {
  /** Configured path (not its realpath), to pass to the SDK. */
  path: string
  /** path + realpath + mtime; changes when the executable changes. */
  identity: string
}

/**
 * Resolve and fully verify the executable: existence, execute permission,
 * and a version at or above CLAUDE_CODE_MIN_VERSION within the probe bound.
 * Successful checks are cached while the file is unchanged; failures always
 * re-check on the next call.
 */
export async function ensureClaudeExecutable(
  env: Record<string, string | undefined> = process.env
): Promise<ClaudeExecutableCheck> {
  const executablePath = resolveClaudeExecutable(env)
  if (!executablePath) {
    throw new ClaudeExecutableError(
      'missing',
      `No Claude Code executable found. ${INSTALL_HINT}`
    )
  }
  return checkClaudeExecutable(executablePath)
}

export interface CheckClaudeExecutableOptions {
  /** Probe deadline; the child is killed and awaited when it expires. */
  timeoutMs?: number
}

/**
 * Verify one executable path. Throws ClaudeExecutableError with an
 * actionable message naming the checked path on every failure kind.
 */
export async function checkClaudeExecutable(
  executablePath: string,
  options: CheckClaudeExecutableOptions = {}
): Promise<ClaudeExecutableCheck> {
  let stats: fs.Stats
  try {
    stats = fs.statSync(executablePath) // follows symlinks, like execution
  } catch {
    throw new ClaudeExecutableError(
      'missing',
      `Claude Code executable not found at ${executablePath}. ${INSTALL_HINT}`
    )
  }
  if (!stats.isFile()) {
    throw new ClaudeExecutableError(
      'not-executable',
      `Claude Code path ${executablePath} is a directory, not an executable. ` +
        'Set KAWAI_CLAUDE_PATH to the claude executable file.'
    )
  }
  try {
    fs.accessSync(executablePath, fs.constants.X_OK)
  } catch {
    throw new ClaudeExecutableError(
      'not-executable',
      `Claude Code executable ${executablePath} is not executable (missing x permission). ${INSTALL_HINT}`
    )
  }

  const cacheKey = versionCacheKey(executablePath, stats)
  if (verifiedKeys.has(cacheKey)) return { path: executablePath, identity: cacheKey }

  const output = await probeVersion(executablePath, options.timeoutMs ?? CLAUDE_VERSION_PROBE_TIMEOUT_MS)
  const version = parseClaudeVersion(output)
  if (!version) {
    throw new ClaudeExecutableError(
      'probe-failed',
      `Could not read the Claude Code version from ${executablePath}: ` +
        `unexpected --version output "${output.trim().slice(0, 200)}". ${INSTALL_HINT}`
    )
  }
  if (compareVersions(version, CLAUDE_CODE_MIN_VERSION) < 0) {
    throw new ClaudeExecutableError(
      'unsupported',
      `Claude Code ${version} at ${executablePath} is older than the supported minimum ` +
        `${CLAUDE_CODE_MIN_VERSION}. Upgrade Claude Code (claude update) or point ` +
        'KAWAI_CLAUDE_PATH at a newer executable.'
    )
  }
  verifiedKeys.add(cacheKey)
  return { path: executablePath, identity: cacheKey }
}

/** Successful `path + realpath + mtime` checks; never holds failures. */
const verifiedKeys = new Set<string>()

/** Test hook: forget cached successes so a fresh check re-probes. */
export function resetClaudeExecutableCache(): void {
  verifiedKeys.clear()
}

function versionCacheKey(executablePath: string, stats: fs.Stats): string {
  const real = fs.realpathSync(executablePath)
  return `${executablePath}\0${real}\0${stats.mtimeMs}`
}

/**
 * Run `<executable> --version` under a deadline. On expiry the child is
 * killed and reaped. The stream reads race the deadline too: a killed
 * child's own grandchild can keep the pipes open, so awaiting them
 * unconditionally would outlive the bound.
 */
async function probeVersion(executablePath: string, timeoutMs: number): Promise<string> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([executablePath, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    throw new ClaudeExecutableError(
      'probe-failed',
      `Could not run ${executablePath} --version: ${
        error instanceof Error ? error.message : String(error)
      }. ${INSTALL_HINT}`
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout: Promise<null> = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Force termination at the deadline even if the probe ignores SIGTERM.
      proc.kill("SIGKILL")
      resolve(null)
    }, timeoutMs)
  })
  const completed: Promise<[string, number]> = Promise.all([
    new Response(proc.stdout).text().catch(() => ''),
    // Drain stderr so a chatty child can never block on a full pipe.
    new Response(proc.stderr).text().catch(() => ''),
    proc.exited,
  ]).then(([stdout, , exitCode]) => [stdout, exitCode] as [string, number])
  try {
    const race = await Promise.race([completed, timeout])
    if (race === null) {
      // Reap the force-killed child before reporting it stopped. Do not
      // await stream reads: descendants may still hold the pipes open.
      await proc.exited
      throw new ClaudeExecutableError(
        'probe-failed',
        `Claude Code at ${executablePath} did not report its version within ` +
          `${timeoutMs} ms and was stopped. ${INSTALL_HINT}`
      )
    }
    const [stdout, exitCode] = race
    if (exitCode !== 0) {
      throw new ClaudeExecutableError(
        'probe-failed',
        `Claude Code at ${executablePath} failed --version with exit code ${exitCode}. ${INSTALL_HINT}`
      )
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

/** Parse the leading MAJOR.MINOR.PATCH from `--version` output. */
export function parseClaudeVersion(output: string): string | null {
  const match = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

/** Numeric triple comparison: negative when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1
    if (pa[i]! > pb[i]!) return 1
  }
  return 0
}
