// Keep parsed tmux formats on tabs. `tmux -u` preserves tabs under minimal
// locales, while the raw unit-separator transport regressed real Linux tmux
// discovery in CI.
const TMUX_FIELD_SEPARATOR = '\t'
const TMUX_UTF8_FLAG = '-u'

// Placeholder window kept alive in the base session so the session itself
// persists even when the user has no real windows. Tmux requires every
// session to contain at least one window, so we run a long-lived no-op here.
// Listings filter the placeholder out of every session (see
// isBootstrapPlaceholderCommand); in the managed session the reserved name
// alone is enough because it cannot be created or renamed there.
const BOOTSTRAP_WINDOW_NAME = '__agentboard_root__'
const BOOTSTRAP_WINDOW_COMMAND = 'tail -f /dev/null'
// #{pane_current_command} fallback shape of the same placeholder.
const BOOTSTRAP_PLACEHOLDER_PROCESS = 'tail'

/**
 * True for the placeholder's start command (and its `pane_current_command`
 * fallback), so leftover base-style sessions — e2e fixtures, manual
 * `new-session -n __agentboard_root__` keep-alives — can be recognized outside
 * the managed session too. Without this they list as phantom terminal rows that
 * cannot be killed (external + allowKillExternal off) nor used as a terminal.
 * Callers pass an already-normalized pane start command.
 */
function isBootstrapPlaceholderCommand(command: string): boolean {
  const trimmed = command.trim().replace(/^["']|["']$/g, '')
  return (
    trimmed === BOOTSTRAP_WINDOW_COMMAND ||
    trimmed === BOOTSTRAP_PLACEHOLDER_PROCESS
  )
}

function withTmuxUtf8Flag(args: string[]): string[] {
  if (args[0] === TMUX_UTF8_FLAG) {
    return args
  }
  return [TMUX_UTF8_FLAG, ...args]
}

function buildTmuxFormat(fields: string[]): string {
  return fields.join(TMUX_FIELD_SEPARATOR)
}

function splitTmuxFields(
  line: string,
  expectedFieldCount: number
): string[] | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR)
  return parts.length === expectedFieldCount ? parts : null
}

function splitTmuxLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
}

export {
  BOOTSTRAP_WINDOW_COMMAND,
  BOOTSTRAP_WINDOW_NAME,
  TMUX_FIELD_SEPARATOR,
  buildTmuxFormat,
  isBootstrapPlaceholderCommand,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
}
