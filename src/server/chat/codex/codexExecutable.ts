// Codex executable selection for Codex chat sessions (codex-chat-sessions
// 4.2). Codex runs as a separately installed CLI, never bundled: resolution
// is server-only (KAWAI_CODEX_PATH, else `codex` on PATH), the value is
// always a single executable path — never split or passed to a shell — and
// never crosses to browsers. A successful version check is cached per
// path/realpath/mtime so an upgrade in place re-checks; failures are never
// cached, so an installed or repaired executable recovers without a server
// restart. The baseline pairs with the vendored protocol types
// (protocol/VERSION, pinned by test).
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions } from '../claudeExecutable'

/**
 * Minimum Codex CLI version Codex chat sessions support. The §1 spike
 * baseline (ruling R6); must stay equal to protocol/VERSION (pinned by
 * test) because the app-server protocol pairs with that CLI build.
 */
export const CODEX_MIN_VERSION = '0.163.0'

/** Default bound for the `--version` probe. */
export const CODEX_VERSION_PROBE_TIMEOUT_MS = 10_000

export type CodexExecutableErrorKind =
  | 'missing'
  | 'not-executable'
  | 'unsupported'
  | 'probe-failed'

export class CodexExecutableError extends Error {
  readonly kind: CodexExecutableErrorKind
  constructor(kind: CodexExecutableErrorKind, message: string) {
    super(message)
    this.name = 'CodexExecutableError'
    this.kind = kind
  }
}

/** Where to find Codex and what to do when it is absent. */
const INSTALL_HINT =
  'Install Codex (https://developers.openai.com/codex) so `codex` is on the server PATH, ' +
  'or set KAWAI_CODEX_PATH to the executable.'

/**
 * Resolve the executable Codex chats will run: the trimmed KAWAI_CODEX_PATH
 * value when non-empty, otherwise `codex` from PATH. Returns null when
 * neither yields a path. The value is one path (never split or run by a
 * shell), made absolute against the server working directory.
 */
export function resolveCodexExecutable(
  env: Record<string, string | undefined> = process.env
): string | null {
  const configured = (env.KAWAI_CODEX_PATH ?? '').trim()
  // Absolute against the server's working directory: verification runs here,
  // but the app-server spawns per session, where a relative path would name
  // a different (or no) file.
  if (configured) return path.resolve(configured)
  const found = Bun.which('codex', { PATH: env.PATH ?? '' })
  return found ? path.resolve(found) : null
}

/** A verified executable: the path to run and its change identity. */
export interface CodexExecutableCheck {
  /** Configured path (not its realpath), to spawn. */
  path: string
  /** path + realpath + mtime; changes when the executable changes. */
  identity: string
}

export interface CheckCodexExecutableOptions {
  /** Probe deadline; the child is killed and awaited when it expires. */
  timeoutMs?: number
}

/**
 * Resolve and fully verify the executable: existence, execute permission,
 * and a version at or above CODEX_MIN_VERSION within the probe bound.
 * Successful checks are cached while the file is unchanged; failures always
 * re-check on the next call.
 */
export async function ensureCodexExecutable(
  env: Record<string, string | undefined> = process.env
): Promise<CodexExecutableCheck> {
  const executablePath = resolveCodexExecutable(env)
  if (!executablePath) {
    throw new CodexExecutableError(
      'missing',
      `No Codex executable found. ${INSTALL_HINT}`
    )
  }
  return checkCodexExecutable(executablePath)
}

/**
 * Verify one executable path. Throws CodexExecutableError with an
 * actionable message naming the checked path on every failure kind.
 */
export async function checkCodexExecutable(
  executablePath: string,
  options: CheckCodexExecutableOptions = {}
): Promise<CodexExecutableCheck> {
  let stats: fs.Stats
  try {
    stats = fs.statSync(executablePath) // follows symlinks, like execution
  } catch {
    throw new CodexExecutableError(
      'missing',
      `Codex executable not found at ${executablePath}. ${INSTALL_HINT}`
    )
  }
  if (!stats.isFile()) {
    throw new CodexExecutableError(
      'not-executable',
      `Codex path ${executablePath} is a directory, not an executable. ` +
        'Set KAWAI_CODEX_PATH to the codex executable file.'
    )
  }
  try {
    fs.accessSync(executablePath, fs.constants.X_OK)
  } catch {
    throw new CodexExecutableError(
      'not-executable',
      `Codex executable ${executablePath} is not executable (missing x permission). ${INSTALL_HINT}`
    )
  }

  const cacheKey = versionCacheKey(executablePath, stats)
  if (verifiedKeys.has(cacheKey)) return { path: executablePath, identity: cacheKey }

  const output = await probeVersion(executablePath, options.timeoutMs ?? CODEX_VERSION_PROBE_TIMEOUT_MS)
  const version = parseCodexVersion(output)
  if (!version) {
    throw new CodexExecutableError(
      'probe-failed',
      `Could not read the Codex version from ${executablePath}: ` +
        `unexpected --version output "${output.trim().slice(0, 200)}". ${INSTALL_HINT}`
    )
  }
  if (compareVersions(version, CODEX_MIN_VERSION) < 0) {
    throw new CodexExecutableError(
      'unsupported',
      `Codex ${version} at ${executablePath} is older than the supported minimum ` +
        `${CODEX_MIN_VERSION}. Upgrade Codex or point KAWAI_CODEX_PATH at a ` +
        'newer executable.'
    )
  }
  verifiedKeys.add(cacheKey)
  return { path: executablePath, identity: cacheKey }
}

/** Successful `path + realpath + mtime` checks; never holds failures. */
const verifiedKeys = new Set<string>()

/** Test hook: forget cached successes so a fresh check re-probes. */
export function resetCodexExecutableCache(): void {
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
    throw new CodexExecutableError(
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
      proc.kill('SIGKILL')
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
      throw new CodexExecutableError(
        'probe-failed',
        `Codex at ${executablePath} did not report its version within ` +
          `${timeoutMs} ms and was stopped. ${INSTALL_HINT}`
      )
    }
    const [stdout, exitCode] = race
    if (exitCode !== 0) {
      throw new CodexExecutableError(
        'probe-failed',
        `Codex at ${executablePath} failed --version with exit code ${exitCode}. ${INSTALL_HINT}`
      )
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse the first MAJOR.MINOR.PATCH in `--version` output. Codex prints
 * `codex-cli 0.163.0` — the version follows the product name, unlike
 * Claude's leading version — so the match is unanchored.
 */
export function parseCodexVersion(output: string): string | null {
  const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}
