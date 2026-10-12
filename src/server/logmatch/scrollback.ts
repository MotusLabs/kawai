// tmux scrollback capture for the match pipeline: plain text (extraction
// input) and ANSI-preserving (Pi TUI color detection), both async so captures
// pace through the match worker.
import { DEFAULT_SCROLLBACK_LINES, runCommandAsync } from './common'
import { withTmuxUtf8Flag } from '../tmuxFormat'

const TMUX_CAPTURE_TIMEOUT_MS = 5000

/** Async capture terminal scrollback with success/failure indicator. */
export async function captureTerminalScrollbackAsync(
  tmuxWindow: string,
  lines = DEFAULT_SCROLLBACK_LINES
): Promise<{ ok: boolean; content: string }> {
  const safeLines = Math.max(1, lines)
  const result = await runCommandAsync(
    ['tmux', ...withTmuxUtf8Flag([
      'capture-pane',
      '-t',
      tmuxWindow,
      '-p',
      '-J',
      '-S',
      `-${safeLines}`,
    ])],
    { timeoutMs: TMUX_CAPTURE_TIMEOUT_MS }
  )
  if (result.exitCode !== 0) {
    return { ok: false, content: '' }
  }
  return { ok: true, content: result.stdout }
}

export async function getTerminalScrollbackWithAnsiAsync(
  tmuxWindow: string,
  lines = DEFAULT_SCROLLBACK_LINES
): Promise<string> {
  const safeLines = Math.max(1, lines)
  const result = await runCommandAsync(
    ['tmux', ...withTmuxUtf8Flag([
      'capture-pane',
      '-t',
      tmuxWindow,
      '-p',
      '-J',
      '-e',
      '-S',
      `-${safeLines}`,
    ])],
    { timeoutMs: TMUX_CAPTURE_TIMEOUT_MS }
  )
  if (result.exitCode !== 0) {
    return ''
  }
  return result.stdout
}
