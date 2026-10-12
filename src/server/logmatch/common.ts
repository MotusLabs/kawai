// Shared low-level pieces for the logmatch modules: the async command runner,
// the profiler and search-options types, and defaults consumed by more than
// one of capture, search, matching, and verification.
export interface ExactMatchProfiler {
  windowMatchRuns: number
  windowMatchMs: number
  tmuxCaptures: number
  tmuxCaptureMs: number
  messageExtractRuns: number
  messageExtractMs: number
  tailReads: number
  tailReadMs: number
  rgListRuns: number
  rgListMs: number
  rgJsonRuns: number
  rgJsonMs: number
  tailScoreRuns: number
  tailScoreMs: number
  rgScoreRuns: number
  rgScoreMs: number
  tieBreakRgRuns: number
  tieBreakRgMs: number
}

export function createExactMatchProfiler(): ExactMatchProfiler {
  return {
    windowMatchRuns: 0,
    windowMatchMs: 0,
    tmuxCaptures: 0,
    tmuxCaptureMs: 0,
    messageExtractRuns: 0,
    messageExtractMs: 0,
    tailReads: 0,
    tailReadMs: 0,
    rgListRuns: 0,
    rgListMs: 0,
    rgJsonRuns: 0,
    rgJsonMs: 0,
    tailScoreRuns: 0,
    tailScoreMs: 0,
    rgScoreRuns: 0,
    rgScoreMs: 0,
    tieBreakRgRuns: 0,
    tieBreakRgMs: 0,
  }
}

interface SpawnResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface SpawnOptions {
  timeoutMs?: number
}

export async function runCommandAsync(
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.timeoutMs && options.timeoutMs > 0
      ? { timeout: options.timeoutMs }
      : {}),
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : '',
    proc.stderr ? new Response(proc.stderr).text() : '',
  ])
  return {
    exitCode: typeof exitCode === 'number' ? exitCode : 1,
    stdout,
    stderr,
  }
}

export const DEFAULT_SCROLLBACK_LINES = 10000

// Minimum length for exact match search
export const MIN_EXACT_MATCH_LENGTH = 5

/**
 * Search for logs containing an exact user message using ripgrep.
 * Searches both Claude and Codex log directories.
 * Uses flexible whitespace matching to handle differences between tmux and log content.
 * Returns list of matching log file paths.
 */
export interface ExactMatchSearchOptions {
  logPaths?: string[]
  tailBytes?: number
  rgThreads?: number
  profile?: ExactMatchProfiler
  /** Log paths to exclude from matching (e.g., logs belonging to other active windows) */
  excludeLogPaths?: string[]
  /** When true, only match events with role === 'user' in the normalized path */
  userOnly?: boolean
  /**
   * Pause in ms between consecutive window scrollback captures in the async
   * matcher (design D4). Paces match bursts so they interleave with
   * interactive terminal traffic instead of monopolizing the tmux server.
   */
  interWindowYieldMs?: number
  /** Injectable wait for tests; defaults to a setTimeout-based sleep. */
  wait?: (ms: number) => Promise<void>
}

export interface ExactMessageSearchOptions extends ExactMatchSearchOptions {
  minLength?: number
}
