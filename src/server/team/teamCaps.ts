// Per-team spawn caps (team-tasks design D6) and plan-execution settings
// (plan-execution D16), read only from the user-level `~/.kawai/teams.json` —
// the caps bound unattended spend, so an agent-writable project file must
// never raise them:
//
//   { "maxSpawnedSessions": 5,
//     "planExecution": { "floorChecks": { "lint": ["ci"], "typecheck": ["ci"], "unit-tests": ["ci"], "ci-e2e": ["e2e"] } },
//     "teams": { "/home/coder/kawai": { "maxSpawnedSessions": 8,
//                "planExecution": { "floorChecks": { ... }, "maxParallelChanges": 3, "mergeMethod": "merge" } } } }
//
// `teams` keys may name the main checkout or any of its worktrees; each is
// resolved to its team id (common git dir) at load. The file is read at
// startup and re-read whenever its mtime/size stamp changes. A malformed file
// or value is reported and the default applies in its place. A top-level
// `planExecution` is the default; a team's entry overrides it field by field
// (an invalid field falls back to the top level's, then to the built-in).
// The floor map has no default: a team without one has `floorChecks: null`,
// and Start refuses it as `landing-ready`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CiFloorCheck, FloorMap, MergeMethod } from '../../shared/planExecution'
import { CI_FLOOR_CHECKS, MERGE_METHODS } from '../../shared/planExecution'
import { resolveTeam } from './teamIdentity'

export const DEFAULT_MAX_SPAWNED_SESSIONS = 5
export const DEFAULT_MAX_PARALLEL_CHANGES = 3
export const DEFAULT_MERGE_METHOD: MergeMethod = 'merge'

/** One configured level's plan-execution values; null = unset or invalid. */
interface ExecutionEntry {
  floorChecks: FloorMap | null
  maxParallelChanges: number | null
  mergeMethod: MergeMethod | null
}

/** D16's settings for one team: the configured floor map or null (no default), with defaulted parallelism and merge method. */
export interface PlanExecutionSettings {
  floorChecks: FloorMap | null
  maxParallelChanges: number
  mergeMethod: MergeMethod
}

interface LoadedCaps {
  global: number
  perTeam: Map<string, number>
  execution: { global: ExecutionEntry; perTeam: Map<string, ExecutionEntry> }
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** Read one `planExecution` object (D16); every malformed value is reported and left unset. */
function readExecution(value: unknown, where: string, errors: string[], file: string): ExecutionEntry {
  const entry: ExecutionEntry = { floorChecks: null, maxParallelChanges: null, mergeMethod: null }
  if (value === undefined || value === null) return entry
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${file}: ${where} must be an object`)
    return entry
  }
  const root = value as { floorChecks?: unknown; maxParallelChanges?: unknown; mergeMethod?: unknown }
  if (root.floorChecks !== undefined) entry.floorChecks = readFloorMap(root.floorChecks, `${where}.floorChecks`, errors, file)
  if (root.maxParallelChanges !== undefined) {
    if (isPositiveInteger(root.maxParallelChanges)) entry.maxParallelChanges = root.maxParallelChanges
    else errors.push(`${file}: ${where}.maxParallelChanges must be a positive integer; using ${DEFAULT_MAX_PARALLEL_CHANGES}`)
  }
  if (root.mergeMethod !== undefined) {
    if (typeof root.mergeMethod === 'string' && MERGE_METHODS.includes(root.mergeMethod as MergeMethod)) {
      entry.mergeMethod = root.mergeMethod as MergeMethod
    } else {
      errors.push(`${file}: ${where}.mergeMethod must be one of ${MERGE_METHODS.join(', ')}; using ${DEFAULT_MERGE_METHOD}`)
    }
  }
  return entry
}

/** A floor map must key exactly the four CI floor checks, each a non-empty list of check names (D16). */
function readFloorMap(value: unknown, where: string, errors: string[], file: string): FloorMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${file}: ${where} must map the CI floor checks (${CI_FLOOR_CHECKS.join(', ')}) to check-name lists`)
    return null
  }
  const map: Partial<Record<CiFloorCheck, string[]>> = {}
  for (const name of CI_FLOOR_CHECKS) {
    const list = (value as Record<string, unknown>)[name]
    if (!Array.isArray(list) || list.length === 0 || list.some(item => typeof item !== 'string' || item.trim() === '')) {
      errors.push(`${file}: ${where}.${name} must be a non-empty list of check names`)
      return null
    }
    map[name] = list as string[]
  }
  for (const key of Object.keys(value)) {
    if (!CI_FLOOR_CHECKS.includes(key as CiFloorCheck)) {
      errors.push(`${file}: ${where} has the unknown check "${key}"; the keys must be ${CI_FLOOR_CHECKS.join(', ')}`)
      return null
    }
  }
  return map as FloorMap
}

export function teamCapsFile(homeDir?: string): string {
  return path.join(homeDir ?? process.env.HOME ?? os.homedir(), '.kawai', 'teams.json')
}

export class TeamCaps {
  /** The last read, keyed by the stamp it was read under. */
  private cache: { stamp: string; caps: Promise<LoadedCaps> } | null = null

  constructor(private readonly options: {
    homeDir?: string
    /** Problems with the file, one line each; defaults apply where they occur. */
    onErrors?: (errors: string[]) => void
  } = {}) {
    // Startup read; later calls re-read only when the file changed.
    void this.current()
  }

  /** The live spawned-session cap for a team id. */
  async maxSpawnedSessions(teamId: string): Promise<number> {
    const caps = await this.current()
    return caps.perTeam.get(teamId) ?? caps.global
  }

  /** The plan-execution settings for a team id (D16): the team's entry over the top-level default over the built-ins. */
  async planExecution(teamId: string): Promise<PlanExecutionSettings> {
    const caps = await this.current()
    const team = caps.execution.perTeam.get(teamId)
    const global = caps.execution.global
    return {
      floorChecks: team?.floorChecks ?? global.floorChecks,
      maxParallelChanges: team?.maxParallelChanges ?? global.maxParallelChanges ?? DEFAULT_MAX_PARALLEL_CHANGES,
      mergeMethod: team?.mergeMethod ?? global.mergeMethod ?? DEFAULT_MERGE_METHOD,
    }
  }

  private stamp(): string {
    try {
      const stat = fs.statSync(teamCapsFile(this.options.homeDir))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }

  private current(): Promise<LoadedCaps> {
    const stamp = this.stamp()
    // Concurrent callers under one stamp share a single read.
    if (this.cache?.stamp !== stamp) this.cache = { stamp, caps: this.load(stamp) }
    return this.cache.caps
  }

  private async load(stamp: string): Promise<LoadedCaps> {
    const file = teamCapsFile(this.options.homeDir)
    const caps: LoadedCaps = {
      global: DEFAULT_MAX_SPAWNED_SESSIONS,
      perTeam: new Map(),
      execution: { global: { floorChecks: null, maxParallelChanges: null, mergeMethod: null }, perTeam: new Map() },
    }
    if (stamp === 'missing') return caps
    const errors: string[] = []
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      this.options.onErrors?.([`${file}: ${(error as Error).message}; using the default cap of ${DEFAULT_MAX_SPAWNED_SESSIONS}`])
      return caps
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.options.onErrors?.([`${file}: expected a JSON object; using the default cap of ${DEFAULT_MAX_SPAWNED_SESSIONS}`])
      return caps
    }
    const root = parsed as { maxSpawnedSessions?: unknown; planExecution?: unknown; teams?: unknown }
    if (root.maxSpawnedSessions !== undefined) {
      if (isPositiveInteger(root.maxSpawnedSessions)) caps.global = root.maxSpawnedSessions
      else errors.push(`${file}: maxSpawnedSessions must be a positive integer; using ${DEFAULT_MAX_SPAWNED_SESSIONS}`)
    }
    caps.execution.global = readExecution(root.planExecution, 'planExecution', errors, file)
    if (root.teams !== undefined) {
      if (!root.teams || typeof root.teams !== 'object' || Array.isArray(root.teams)) {
        errors.push(`${file}: teams must be an object of repository paths`)
      } else {
        for (const [key, value] of Object.entries(root.teams as Record<string, unknown>)) {
          if (!path.isAbsolute(key)) {
            errors.push(`${file}: teams key "${key}" must be an absolute path`)
            continue
          }
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            errors.push(`${file}: teams["${key}"] must be an object`)
            continue
          }
          const entry = value as { maxSpawnedSessions?: unknown; planExecution?: unknown }
          if (entry.maxSpawnedSessions !== undefined) {
            if (isPositiveInteger(entry.maxSpawnedSessions)) caps.perTeam.set((await resolveTeam(key)).teamId, entry.maxSpawnedSessions)
            else errors.push(`${file}: teams["${key}"].maxSpawnedSessions must be a positive integer`)
          }
          if (entry.planExecution !== undefined) {
            caps.execution.perTeam.set((await resolveTeam(key)).teamId, readExecution(entry.planExecution, `teams["${key}"].planExecution`, errors, file))
          }
        }
      }
    }
    if (errors.length > 0) this.options.onErrors?.(errors)
    return caps
  }
}
