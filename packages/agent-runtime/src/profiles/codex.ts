// The Codex profile helper (design §4, task 3.1): the child environment for
// a Codex app-server whose login lives in an explicit CODEX_HOME. Claude and
// Anthropic authority, other Codex credentials and withheld names are
// removed; CODEX_HOME is the selected home only. A shared home is explicit
// authority to use its owner's login, never a credential copied anywhere.
import { isAbsolute } from 'node:path'
import { CODEX_FAMILY_NAMES, configurationError, freeze, isClaudeFamily, readBase, readWithheld, refuseWithheldCollisions, requireValue, type EnvMap } from './env.js'

export interface CodexProfileInput {
  base: EnvMap
  /** Absolute path of the Codex home holding the login. */
  codexHome: string
  withheld?: readonly string[]
}

export interface CodexProfile {
  childEnv: EnvMap
}

export function codexProfile(input: CodexProfileInput): CodexProfile {
  const codexHome = requireValue('codexHome', input.codexHome)
  if (!isAbsolute(codexHome)) throw configurationError('codexHome must be an absolute path')
  const base = readBase(input.base)
  const withheld = readWithheld(input.withheld)
  refuseWithheldCollisions(withheld, ['CODEX_HOME'], 'Codex')
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (withheld.has(name) || isClaudeFamily(name) || (CODEX_FAMILY_NAMES as readonly string[]).includes(name)) continue
    env[name] = value
  }
  env.CODEX_HOME = codexHome
  return { childEnv: freeze(env) }
}
