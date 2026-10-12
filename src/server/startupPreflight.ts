// Boot preflight run before anything binds or spawns: refuse to start when
// the port already has a listener (exit 1 naming the owning process), and
// prune orphaned per-connection tmux sessions (`<tmuxSession>-ws-*`, none
// attached) left by a previous server process.
import { config } from './config'
import { logger } from './logger'
import {
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from './tmuxFormat'

export function checkPortAvailable(port: number): void {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    // Use -sTCP:LISTEN to only match processes actually listening on the port,
    // not stale/closed connections from other processes (e.g. Playwright/Chrome)
    result = Bun.spawnSync(['lsof', '-i', `:${port}`, '-sTCP:LISTEN', '-t'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return
  }
  const pids = result.stdout?.toString().trim() ?? ''
  if (pids) {
    const pidList = pids.split('\n').filter(Boolean)
    const pid = pidList[0]
    // Get process name
    let processName = 'unknown'
    try {
      const nameResult = Bun.spawnSync(['ps', '-p', pid, '-o', 'comm='], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      processName = nameResult.stdout?.toString().trim() || 'unknown'
    } catch {
    }
    logger.error('port_in_use', { port, pid, processName })
    process.exit(1)
  }
}

export function pruneOrphanedWsSessions(): void {
  if (!config.pruneWsSessions) {
    return
  }

  const prefix = `${config.tmuxSession}-ws-`
  if (!prefix) {
    return
  }

  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(
      ['tmux', ...withTmuxUtf8Flag([
        'list-sessions',
        '-F',
        buildTmuxFormat(['#{session_name}', '#{session_attached}']),
      ])],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      }
    )
    if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
      logger.warn('ws_session_prune_skipped', {
        reason: 'tmux_timeout',
        timeoutMs: config.tmuxTimeoutMs,
      })
      return
    }
  } catch {
    return
  }

  if (result.exitCode !== 0) {
    return
  }

  const output = result.stdout?.toString() ?? ''
  if (!output) {
    return
  }
  const lines = splitTmuxLines(output)
  let pruned = 0

  for (const line of lines) {
    const parts = splitTmuxFields(line, 2)
    if (!parts) continue
    const [name, attachedRaw] = parts
    if (!name || !name.startsWith(prefix)) continue
    const attached = Number.parseInt(attachedRaw ?? '', 10)
    if (Number.isNaN(attached) || attached > 0) continue
    try {
      const killResult = Bun.spawnSync(['tmux', 'kill-session', '-t', name], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: config.tmuxTimeoutMs,
      })
      if (killResult.signalCode === 'SIGTERM' || killResult.exitCode === null) {
        continue
      }
      if (killResult.exitCode === 0) {
        pruned += 1
      }
    } catch {
      // Ignore kill errors
    }
  }

  if (pruned > 0) {
    logger.info('ws_sessions_pruned', { count: pruned })
  }
}
