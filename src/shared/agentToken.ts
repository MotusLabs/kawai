// agentToken.ts - Resolve the agent token from a start command string.
// Shared by the server's exact-match agent detection (agentDetection.ts) and
// the session form's claude*/codex* prefix defaulting, so both skip runners,
// env assignments, and flags the same way.

function unquoteShellString(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if (first === "'" && last === "'") {
      // Undo our shellQuote escaping: 'foo'\''bar' -> foo'bar
      return trimmed.slice(1, -1).replace(/'\\''/g, "'")
    }
    if (first === '"' && last === '"') {
      // Best-effort: handle basic escapes.
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  return trimmed
}

function unwrapBashLoginWrapper(command: string): string | null {
  // Expect: bash -lc/-lic <cmd>. Some tmux formatters lose quoting, so treat
  // the "cmd" as the rest of the string after the flags token.
  const trimmed = command.trim()
  const firstSpace = trimmed.search(/\s/)
  if (firstSpace === -1) return null

  const bashToken = trimmed.slice(0, firstSpace)
  const bashBase = bashToken.split('/').pop()
  if (bashBase !== 'bash') return null

  let idx = firstSpace
  while (idx < trimmed.length && /\s/.test(trimmed[idx]!)) idx++

  let sawLogin = false
  let sawCommand = false

  while (idx < trimmed.length) {
    const tokenStart = idx
    while (idx < trimmed.length && !/\s/.test(trimmed[idx]!)) idx++
    const tok = trimmed.slice(tokenStart, idx)
    while (idx < trimmed.length && /\s/.test(trimmed[idx]!)) idx++

    if (!tok.startsWith('-') || tok === '-') {
      return null
    }
    if (tok === '--') {
      break
    }
    if (tok.startsWith('--')) {
      // Ignore long options; we only care about short option bundles like -lc/-lic.
      continue
    }
    if (!/^-[a-zA-Z]+$/.test(tok)) {
      continue
    }

    const letters = tok.slice(1)
    if (letters.includes('l')) sawLogin = true
    if (letters.includes('c')) {
      sawCommand = true
      break
    }
  }

  if (!sawLogin || !sawCommand) return null

  const rest = trimmed.slice(idx).trim()
  if (!rest) return null
  return unquoteShellString(rest)
}

export function normalizePaneStartCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  // tmux #{pane_start_command} may wrap the entire command in quotes
  const unquoted = unquoteShellString(trimmed)
  const unwrapped = unwrapBashLoginWrapper(unquoted)
  return unwrapped ?? unquoted
}

/**
 * The first meaningful token of a command as a lowercase basename: skips
 * package runners (npx/bunx/pnpm/yarn/env), KEY=value assignments, and
 * leading flags, then takes the basename of the first token that remains.
 * Undefined when nothing meaningful remains.
 */
export function resolveAgentToken(command: string): string | undefined {
  const normalizedInput = normalizePaneStartCommand(command)
  if (!normalizedInput) {
    return undefined
  }

  const normalized = normalizedInput.toLowerCase().trim().replace(/^["']|["']$/g, '')
  for (const part of normalized.split(/\s+/)) {
    if (['npx', 'bunx', 'pnpm', 'yarn', 'env'].includes(part)) {
      continue
    }
    if (part.includes('=')) {
      continue
    }
    if (part.startsWith('-')) {
      continue
    }
    return part.split('/').pop() || part
  }
  return undefined
}

/**
 * Prefix rule for the first-prompt selector's default: a resolved token
 * beginning with `claude` or `codex` maps onto that agent — so wrappers like
 * `claude-glm` or `codex-foo` resolve — and everything else maps to none.
 */
export function autoStartAgentFromToken(
  token: string | undefined
): 'claude' | 'codex' | null {
  if (!token) return null
  if (token.startsWith('claude')) return 'claude'
  if (token.startsWith('codex')) return 'codex'
  return null
}
