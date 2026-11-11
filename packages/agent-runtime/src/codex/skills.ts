// Native Codex skills (moved from Kawai's codexCommands.ts and
// CodexCommandDiscovery.ts, autocomplete D1-D3; task 6.1 R2 A9/V7). Private:
// no public input-item API. The app-server's own `skills/list` catalog is
// the only source of both the public slash-command list (onCommandState) and
// the private skill paths a turn's input carries; no caller-supplied path or
// filesystem scan is used.
// - A catalog is valid only when the reply names exactly the listed cwd with
//   skill and error arrays. Enabled skills with a safe name, an absolute
//   path, a description and a known scope are kept; clear/reset/new are
//   reserved; one name with two paths is a conflict and is dropped.
// - Discovery is per generation: it starts loading at the process's start,
//   scans once the thread is ready, and rescans (forceReload) on
//   `skills/changed` and on setSkillDirectory (R11), which lists the new
//   directory from then on; it never changes the thread's or a launch's cwd. Only the latest request may publish; a burst coalesces
//   into one follow-up. Each request is owned work the stop joins; a failure
//   or an unsupported method makes the list unavailable and never fails a turn.
// - A turn's text references a skill only by a whole whitespace-delimited
//   `/name`; each skill is appended once, in first-use order, after the text.
import path from 'node:path'
import type { CommandState, SlashCommand } from '../activity.js'

export interface CodexSkillInput {
  type: 'skill'
  name: string
  path: string
}

export interface CodexSkillCatalog {
  commands: SlashCommand[]
  skills: Map<string, CodexSkillInput>
  loadErrors: number
  conflicts: string[]
}

const object = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
const RESERVED = new Set(['clear', 'reset', 'new'])
const SOURCES = { repo: 'project', user: 'user', system: 'builtin', admin: 'builtin' } as const

/** Null is a failed discovery; an empty catalog is a successful empty list. */
export function codexSkillCatalog(response: unknown, cwd: string): CodexSkillCatalog | null {
  const data = object(response)?.data
  if (!Array.isArray(data) || !absolute(cwd)) return null
  const entries = data.map(object)
  if (entries.some((entry) => !entry || !absolute(entry.cwd))) return null
  const matching = entries.filter((entry) => path.resolve(entry!.cwd as string) === path.resolve(cwd))
  if (matching.length !== 1) return null
  const entry = matching[0]!
  if (!Array.isArray(entry.skills) || !Array.isArray(entry.errors)) return null
  const groups = new Map<string, { command: SlashCommand; skill: CodexSkillInput }>()
  const conflicts = new Set<string>()
  for (const raw of entry.skills) {
    const skill = object(raw)
    if (
      !skill || skill.enabled !== true || typeof skill.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(skill.name) || RESERVED.has(skill.name.toLowerCase()) ||
      !absolute(skill.path) || typeof skill.description !== 'string' || typeof skill.scope !== 'string' || !Object.hasOwn(SOURCES, skill.scope)
    ) continue
    const previous = groups.get(skill.name)
    if (previous) {
      if (previous.skill.path !== skill.path) conflicts.add(skill.name)
      continue
    }
    const description = [object(skill.interface)?.shortDescription, skill.shortDescription, skill.description].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? ''
    groups.set(skill.name, {
      command: { name: skill.name, description, aliases: [], source: SOURCES[skill.scope as keyof typeof SOURCES] },
      skill: { type: 'skill', name: skill.name, path: skill.path },
    })
  }
  const names = [...groups.keys()].filter((name) => !conflicts.has(name)).sort()
  return {
    commands: names.map((name) => groups.get(name)!.command),
    skills: new Map(names.map((name) => [name, groups.get(name)!.skill])),
    loadErrors: entry.errors.length,
    conflicts: [...conflicts].sort(),
  }
}

/** Whole whitespace-delimited slash names only, once each, in first-use order. */
export function codexSkillInputs(text: string, catalog: CodexSkillCatalog | null): CodexSkillInput[] {
  const found = new Map<string, CodexSkillInput>()
  for (const word of text.split(/\s+/)) {
    if (!word.startsWith('/')) continue
    const skill = catalog?.skills.get(word.slice(1))
    if (skill && !found.has(skill.name)) found.set(skill.name, { ...skill })
  }
  return [...found.values()]
}

export interface SkillDiscoveryHost {
  /** Send `skills/list` on that generation as owned work; null when no work is admitted. */
  request(generation: object, params: Record<string, unknown>): Promise<unknown> | null
  publish(state: CommandState): void
  warn(fields: Record<string, unknown>, message: string): void
}

/** One driver's skill discovery; the generation object is its identity. */
export class CodexSkillDiscovery {
  private generation: object | null = null
  private cwd = ''
  private booted = false
  private pending = false
  private forceReload = false
  private identity = {}
  private flight: Promise<void> | null = null
  private catalog: CodexSkillCatalog | null = null
  private state: CommandState = { status: 'unavailable', commands: [] }

  constructor(private readonly host: SkillDiscoveryHost) {}

  inputs(text: string): CodexSkillInput[] {
    return codexSkillInputs(text, this.catalog)
  }

  /** A new generation's process started: its list is loading. */
  start(generation: object, cwd: string): void {
    this.stop()
    this.generation = generation
    this.cwd = cwd
    this.invalidate(false)
  }

  /** The generation's thread is ready: scan. */
  ready(generation: object): void {
    if (this.generation !== generation) return
    this.booted = true
    this.scan()
  }

  /** R11 setSkillDirectory: the live generation lists `cwd` instead, with forceReload; no generation, nothing. */
  changeDirectory(cwd: string): void {
    if (!this.generation || cwd === this.cwd) return
    this.cwd = cwd
    this.invalidate(true)
  }

  /** `skills/changed`: rescan with forceReload. */
  changed(generation: object): void {
    if (this.generation === generation) this.invalidate(true)
  }

  /** The generation ended or the driver stops: nothing is listed and no path is kept. */
  stop(generation?: object): void {
    if (generation !== undefined && generation !== this.generation) return
    this.generation = null
    this.booted = false
    this.pending = false
    this.forceReload = false
    this.flight = null
    this.identity = {}
    this.setState('unavailable')
  }

  private invalidate(forceReload: boolean): void {
    if (!this.generation) return
    this.identity = {}
    this.pending = true
    this.forceReload ||= forceReload
    this.setState('loading')
    this.scan()
  }

  private scan(): void {
    if (!this.generation || !this.booted || this.flight || !this.pending) return
    const { generation, cwd, identity, forceReload } = this
    this.pending = false
    this.forceReload = false
    const current = () => this.generation === generation && this.cwd === cwd && this.identity === identity
    const reply = this.host.request(generation, { cwds: [cwd], forceReload })
    if (!reply) return
    const flight = reply
      .then((response) => {
        if (!current()) return
        const catalog = codexSkillCatalog(response, cwd)
        if (!catalog) return this.setState('unavailable')
        if (catalog.loadErrors || catalog.conflicts.length) this.host.warn({ cwd, loadErrors: catalog.loadErrors, conflicts: catalog.conflicts }, 'codex_skill_catalog_partial')
        this.setState('ready', catalog)
      })
      .catch(() => {
        // Discovery is optional: an unsupported method, a refusal or a closed process never fails a turn.
        if (current()) this.setState('unavailable')
      })
      .finally(() => {
        if (this.flight !== flight) return
        this.flight = null
        this.scan()
      })
    this.flight = flight
  }

  private setState(status: CommandState['status'], catalog: CodexSkillCatalog | null = null): void {
    this.catalog = catalog
    const next: CommandState = { status, commands: catalog?.commands ?? [] }
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.host.publish({ status: next.status, commands: next.commands.map((command) => ({ ...command, aliases: [...command.aliases] })) })
  }
}
