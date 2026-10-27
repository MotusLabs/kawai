// Publishes the routing rule contract (`src/shared/routing.ts`) to rule
// authors as `~/.kawai/routing/kawai-routing.d.ts`, so a rule can write
// `import type { RoutingRule } from './kawai-routing'` and get editor types.
// The contract is type-only, so its source is a valid declaration file as-is.
// Rewritten only when the content differs (rule loads must not churn mtimes).
// The contract is embedded as text at build time: a compiled binary has no
// source tree, and `import.meta.dir` there is `/$bunfs/root`.
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error -- Bun text import: TS types the module, not its text.
import CONTRACT_SOURCE from '../../../shared/routing.ts' with { type: 'text' }

export const RULE_TYPES_FILE = 'kawai-routing.d.ts'

/** Write the declaration file into `dir`; returns its path, or null when the directory is absent. */
export function publishRuleTypes(dir: string): string | null {
  if (!fs.existsSync(dir)) return null
  const target = path.join(dir, RULE_TYPES_FILE)
  const content: string = CONTRACT_SOURCE
  let current: string | null = null
  try {
    current = fs.readFileSync(target, 'utf8')
  } catch {
    // Not published yet.
  }
  if (current !== content) fs.writeFileSync(target, content)
  return target
}
