// User-level routing rules (profile-routing design D1–D3): one rule per group
// id from `~/.kawai/routing/<group>.ts` — never from a project directory,
// which agents can write. Rules load at server start and on an explicit
// reload only; there is no file watching, so a file an agent plants or edits
// does nothing until a human reloads. A reload rebuilds every Worker and
// reports each rule's result, including which files changed since the last
// load. A rule that fails to load leaves its group on the built-in strategy.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GROUP_ID_PATTERN } from '../groupCatalog'
import { RuleHost } from './ruleHost'
import { publishRuleTypes, RULE_TYPES_FILE } from './ruleTypes'

export type RuleChange = 'added' | 'changed' | 'removed' | 'unchanged'

export interface RuleLoadResult {
  groupId: string
  file: string
  ok: boolean
  error?: string
  /** Compared with the previous load. */
  change: RuleChange
  /** Variables the rule declared (and received). */
  env?: string[]
}

export interface RuleLoadReport {
  loadedAt: string
  dir: string
  rules: RuleLoadResult[]
}

export class RuleRegistry {
  private hosts = new Map<string, RuleHost>()
  private stamps = new Map<string, string>()
  private report: RuleLoadReport | null = null
  private loading: Promise<RuleLoadReport> | null = null
  private closed = false

  constructor(private readonly options: {
    homeDir?: string
    env?: Record<string, string | undefined>
    onLoaded?: (report: RuleLoadReport) => void
  } = {}) {}

  get dir(): string {
    const home = this.options.homeDir ?? process.env.HOME ?? os.homedir()
    return path.join(home, '.kawai', 'routing')
  }

  /** The loaded rule of a group, if any. */
  rule(groupId: string): RuleHost | undefined {
    return this.hosts.get(groupId)
  }

  /** The latest load report; null before the first load. */
  lastReport(): RuleLoadReport | null {
    return this.report
  }

  /** Load (or reload) every rule file. Concurrent calls share one pass. */
  reload(): Promise<RuleLoadReport> {
    if (!this.loading) {
      this.loading = this.loadAll().finally(() => { this.loading = null })
    }
    return this.loading
  }

  close(): void {
    this.closed = true
    for (const host of this.hosts.values()) host.close()
    this.hosts.clear()
  }

  private async loadAll(): Promise<RuleLoadReport> {
    const dir = this.dir
    publishRuleTypes(dir)
    const version = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const results: RuleLoadResult[] = []
    const next = new Map<string, RuleHost>()
    const stamps = new Map<string, string>()
    for (const { groupId, file } of listRuleFiles(dir, results)) {
      const stamp = fileStamp(file)
      stamps.set(groupId, stamp)
      const previous = this.stamps.get(groupId)
      const change: RuleChange = previous === undefined ? 'added' : previous === stamp ? 'unchanged' : 'changed'
      const host = new RuleHost(file, this.options.env ?? process.env, version)
      try {
        await host.load()
        next.set(groupId, host)
        results.push({ groupId, file, ok: true, change, env: host.declaredEnv })
      } catch (error) {
        host.close()
        results.push({ groupId, file, ok: false, error: error instanceof Error ? error.message : String(error), change })
      }
    }
    for (const [groupId] of this.stamps) {
      if (!stamps.has(groupId)) results.push({ groupId, file: path.join(dir, `${groupId}.ts`), ok: true, change: 'removed' })
    }
    // Closed while loading: nothing may outlive the registry.
    if (this.closed) for (const host of next.values()) host.close()
    // Swap only after every new Worker is ready, then retire the old ones.
    const old = this.closed ? new Map<string, RuleHost>() : this.hosts
    if (this.closed) next.clear()
    this.hosts = next
    this.stamps = stamps
    for (const host of old.values()) host.close()
    results.sort((a, b) => a.groupId.localeCompare(b.groupId))
    this.report = { loadedAt: new Date().toISOString(), dir, rules: results }
    this.options.onLoaded?.(this.report)
    return this.report
  }
}

/** Rule files in `dir`; misnamed `.ts` files are reported as failed results. */
function listRuleFiles(dir: string, results: RuleLoadResult[]): Array<{ groupId: string; file: string }> {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const files: Array<{ groupId: string; file: string }> = []
  for (const name of names.sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name === RULE_TYPES_FILE) continue
    const groupId = name.slice(0, -'.ts'.length)
    const file = path.join(dir, name)
    if (!GROUP_ID_PATTERN.test(groupId)) {
      results.push({ groupId, file, ok: false, error: `"${groupId}" is not a valid group id`, change: 'unchanged' })
      continue
    }
    files.push({ groupId, file })
  }
  return files
}

/** Content hash: an edit is a change even when size and mtime tick match. */
function fileStamp(file: string): string {
  try {
    return Bun.hash(fs.readFileSync(file)).toString(36)
  } catch {
    return 'missing'
  }
}
