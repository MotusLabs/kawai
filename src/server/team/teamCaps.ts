// Per-team spawn caps (team-tasks design D6), read only from the user-level
// `~/.kawai/teams.json` — the cap bounds unattended spend, so an
// agent-writable project file must never raise it:
//
//   { "maxSpawnedSessions": 5,
//     "teams": { "/home/coder/kawai": { "maxSpawnedSessions": 8 } } }
//
// `teams` keys may name the main checkout or any of its worktrees; each is
// resolved to its team id (common git dir) at load. The file is read at
// startup and re-read whenever its mtime/size stamp changes. A malformed file
// or value is reported and the default (5) applies in its place.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveTeam } from './teamIdentity'

export const DEFAULT_MAX_SPAWNED_SESSIONS = 5

interface LoadedCaps {
  global: number
  perTeam: Map<string, number>
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

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
    const caps: LoadedCaps = { global: DEFAULT_MAX_SPAWNED_SESSIONS, perTeam: new Map() }
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
    const root = parsed as { maxSpawnedSessions?: unknown; teams?: unknown }
    if (root.maxSpawnedSessions !== undefined) {
      if (isPositiveInteger(root.maxSpawnedSessions)) caps.global = root.maxSpawnedSessions
      else errors.push(`${file}: maxSpawnedSessions must be a positive integer; using ${DEFAULT_MAX_SPAWNED_SESSIONS}`)
    }
    if (root.teams !== undefined) {
      if (!root.teams || typeof root.teams !== 'object' || Array.isArray(root.teams)) {
        errors.push(`${file}: teams must be an object of repository paths`)
      } else {
        for (const [key, value] of Object.entries(root.teams as Record<string, unknown>)) {
          const cap = (value as { maxSpawnedSessions?: unknown } | null)?.maxSpawnedSessions
          if (!path.isAbsolute(key)) {
            errors.push(`${file}: teams key "${key}" must be an absolute path`)
          } else if (!isPositiveInteger(cap)) {
            errors.push(`${file}: teams["${key}"].maxSpawnedSessions must be a positive integer`)
          } else {
            caps.perTeam.set((await resolveTeam(key)).teamId, cap)
          }
        }
      }
    }
    if (errors.length > 0) this.options.onErrors?.(errors)
    return caps
  }
}
