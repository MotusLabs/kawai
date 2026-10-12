// Publishes the routing rule contract (`src/shared/routing.ts`) to rule
// authors as `~/.kawai/routing/kawai-routing.d.ts`, so a rule can write
// `import type { RoutingRule } from './kawai-routing'` and get editor types.
// The contract is type-only, so its source is a valid declaration file as-is.
// Rewritten only when the content differs (rule loads must not churn mtimes).
import fs from 'node:fs'
import path from 'node:path'

export const RULE_TYPES_FILE = 'kawai-routing.d.ts'
const CONTRACT = path.resolve(import.meta.dir, '../../../shared/routing.ts')

/** Write the declaration file into `dir`; returns its path, or null when the directory is absent. */
export function publishRuleTypes(dir: string): string | null {
  if (!fs.existsSync(dir)) return null
  const target = path.join(dir, RULE_TYPES_FILE)
  const content = fs.readFileSync(CONTRACT, 'utf8')
  let current: string | null = null
  try {
    current = fs.readFileSync(target, 'utf8')
  } catch {
    // Not published yet.
  }
  if (current !== content) fs.writeFileSync(target, content)
  return target
}
