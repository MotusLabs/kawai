// gitCommand.ts - Argument-array git invocation with timeout and bounded output.
// Never builds shell strings: every argument is a separate argv element, so
// injection via branch names or paths is not possible.

export const GIT_TIMEOUT_MS = 10_000
export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Environment variables that redirect Git's repository discovery away from
 * the explicit `cwd`. Git exports GIT_DIR/GIT_COMMON_DIR/GIT_INDEX_FILE to
 * hook scripts, so a process started from inside a git hook (e.g. the
 * pre-commit test gate) silently resolves every command against the hook's
 * repository instead of the requested working directory. Strip them so the
 * cwd argument stays authoritative; callers can still pass them explicitly
 * through the `env` option.
 */
const GIT_DISCOVERY_ENV_KEYS = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const

/** Process env without Git discovery redirects (never mutates process.env). */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of GIT_DISCOVERY_ENV_KEYS) {
    delete env[key]
  }
  return env
}

export interface GitCommandOptions {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  env?: Record<string, string>
}

export interface GitCommandResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Run git asynchronously with a timeout and output bound. Workspace
 * discovery uses this variant so subprocesses never block the event loop:
 * keystrokes, WebSocket traffic, and signal handling keep flowing while git
 * runs. A timeout kills the process; the killed exit resolves as a
 * non-success with exitCode null, matching the sync variant.
 */
export async function runGitAsync(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
  const { cwd, timeoutMs = GIT_TIMEOUT_MS, maxOutputBytes = GIT_MAX_OUTPUT_BYTES, env } = options
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['git', ...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      env: env ? { ...cleanGitEnv(), ...env } : cleanGitEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    // Missing cwd, git not installed, or spawn failure — treat as non-success.
    return { ok: false, exitCode: null, stdout: '', stderr: '' }
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    return {
      ok: exitCode === 0,
      exitCode,
      stdout: stdout.length > maxOutputBytes ? stdout.slice(0, maxOutputBytes) : stdout,
      stderr: stderr.length > maxOutputBytes ? stderr.slice(0, maxOutputBytes) : stderr,
    }
  } catch {
    return { ok: false, exitCode: null, stdout: '', stderr: '' }
  } finally {
    clearTimeout(timer)
  }
}

/** Run git synchronously with a timeout and output bound.
 * Prefer runGitAsync on request paths: spawnSync blocks the event loop. */
export function runGit(args: string[], options: GitCommandOptions = {}): GitCommandResult {
  const {
    cwd,
    timeoutMs = GIT_TIMEOUT_MS,
    maxOutputBytes = GIT_MAX_OUTPUT_BYTES,
    env,
  } = options
  try {
    const result = Bun.spawnSync(['git', ...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      timeout: timeoutMs,
      env: env ? { ...cleanGitEnv(), ...env } : cleanGitEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = result.stdout ? result.stdout.toString('utf8') : ''
    const stderr = result.stderr ? result.stderr.toString('utf8') : ''
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: stdout.length > maxOutputBytes ? stdout.slice(0, maxOutputBytes) : stdout,
      stderr: stderr.length > maxOutputBytes ? stderr.slice(0, maxOutputBytes) : stderr,
    }
  } catch {
    // Missing cwd, git not installed, or spawn failure — treat as non-success.
    return { ok: false, exitCode: null, stdout: '', stderr: '' }
  }
}

/** Like runGit but throws a GitCommandError when git exits non-zero. */
export class GitCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(`git ${args[0] ?? ''} failed (exit ${exitCode ?? 'signal'}): ${stderr.trim().slice(0, 200)}`)
    this.name = 'GitCommandError'
  }
}

export function runGitChecked(args: string[], options: GitCommandOptions = {}): string {
  const result = runGit(args, options)
  if (!result.ok) {
    throw new GitCommandError(args, result.exitCode, result.stderr)
  }
  return result.stdout
}
