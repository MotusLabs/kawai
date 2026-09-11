// gitCommand.ts - Argument-array git invocation with timeout and bounded output.
// Never builds shell strings: every argument is a separate argv element, so
// injection via branch names or paths is not possible.

export const GIT_TIMEOUT_MS = 10_000
export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024

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

/** Run git synchronously with a timeout and output bound. */
export function runGit(args: string[], options: GitCommandOptions = {}): GitCommandResult {
  const {
    cwd,
    timeoutMs = GIT_TIMEOUT_MS,
    maxOutputBytes = GIT_MAX_OUTPUT_BYTES,
    env,
  } = options
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(['git', ...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      timeout: timeoutMs,
      env: env ? { ...process.env, ...env } : process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    // Missing cwd, git not installed, or spawn failure — treat as non-success.
    return { ok: false, exitCode: null, stdout: '', stderr: '' }
  }
  const stdout = result.stdout ? result.stdout.toString('utf8') : ''
  const stderr = result.stderr ? result.stderr.toString('utf8') : ''
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: stdout.length > maxOutputBytes ? stdout.slice(0, maxOutputBytes) : stdout,
    stderr: stderr.length > maxOutputBytes ? stderr.slice(0, maxOutputBytes) : stderr,
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
