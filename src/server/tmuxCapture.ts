// Async tmux capture runner shared by the clipboard watch, copy-mode probes,
// terminal scrollback capture, and the wake rematcher.
/**
 * Run a read-only tmux command without blocking the event loop. The clipboard
 * watch polls on a 750ms timer, so using the synchronous Bun.spawnSync here
 * would stall terminal streaming for every session on each tick (up to
 * tmuxTimeoutMs if tmux is slow). Bun.spawn keeps it off the JS thread.
 */
import { withTmuxUtf8Flag } from './tmuxFormat'
import { config } from './config'

export async function readTmuxCapture(tmuxArgs: string[]): Promise<string | null> {
  // Belt-and-suspenders timeout: don't rely solely on Bun.spawn's `timeout`
  // option. Guarantee the process is killed (and thus `exited`/stdout resolve)
  // so a hung tmux can never leave clipboardPollInFlight stuck forever.
  let killTimer: ReturnType<typeof setTimeout> | null = null
  let kill: (() => void) | null = null
  try {
    const proc = Bun.spawn(['tmux', ...withTmuxUtf8Flag(tmuxArgs)], {
      stdout: 'pipe',
      // Ignore stderr rather than piping it: we never read it, and an
      // undrained pipe could fill its OS buffer and block the process exit.
      stderr: 'ignore',
      timeout: config.tmuxTimeoutMs,
      killSignal: 'SIGKILL',
    })
    kill = () => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already exited
      }
    }
    killTimer = setTimeout(kill, config.tmuxTimeoutMs + 250)
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (exitCode !== 0) return null
    return stdout
  } catch {
    kill?.()
    return null
  } finally {
    if (killTimer !== null) clearTimeout(killTimer)
  }
}
