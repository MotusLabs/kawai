// Records agent starts (team-process-metrics D2). The chat manager calls
// `record` from the driver's onSpawn hook with what the spawn launched with;
// the recorder hashes the inputs (provenanceHash.ts), writes the start and its
// memory manifest (`INSERT OR IGNORE`, one row per distinct directory state),
// and remembers the session's latest start so turn usage (D1) can name it.
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { computeProvenance, type ProvenanceInput } from './provenanceHash'

export interface AgentStartInput extends ProvenanceInput {
  sessionId: string
  teamId: string | null
  groupId: string | null
  profileId: string | null
  model: string | null
  effort: string | null
  cwd: string
}

export interface AgentStartRow {
  id: string
  sessionId: string
  teamId: string | null
  groupId: string | null
  profileId: string | null
  model: string | null
  effort: string | null
  cwd: string
  groupFileHash: string | null
  promptAppendHash: string | null
  memoryHash: string | null
  memoryFiles: number | null
  instructionsHash: string | null
  unavailable: string[]
  startedAt: string
}

export class ProvenanceRecorder {
  private readonly latest = new Map<string, string>()

  constructor(private readonly db: Database) {}

  /** Hash the inputs and write one start; returns its id. */
  record(input: AgentStartInput, now = new Date().toISOString()): string {
    const provenance = computeProvenance(input)
    const id = `start-${randomUUID()}`
    this.db.transaction(() => {
      if (provenance.memory) {
        this.db.prepare('INSERT OR IGNORE INTO memory_manifests (memory_hash, files) VALUES (?, ?)')
          .run(provenance.memory.hash, JSON.stringify(provenance.memory.files))
      }
      this.db.prepare(`INSERT INTO agent_starts (id, session_id, team_id, group_id, profile_id, model, effort, cwd,
        group_file_hash, prompt_append_hash, memory_hash, memory_files, instructions_hash, unavailable, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, input.sessionId, input.teamId, input.groupId, input.profileId, input.model, input.effort, input.cwd,
        provenance.groupFileHash, provenance.promptAppendHash, provenance.memory?.hash ?? null,
        provenance.memory ? Object.keys(provenance.memory.files).length : null, provenance.instructionsHash,
        provenance.unavailable.length > 0 ? JSON.stringify(provenance.unavailable) : null, now,
      )
    })()
    this.latest.set(input.sessionId, id)
    return id
  }

  /** The session's latest start id: this process's, else the newest recorded. */
  latestStart(sessionId: string): string | null {
    const known = this.latest.get(sessionId)
    if (known) return known
    const row = this.db.prepare('SELECT id FROM agent_starts WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(sessionId) as { id: string } | null
    return row?.id ?? null
  }

  starts(sessionId: string): AgentStartRow[] {
    const rows = this.db.prepare('SELECT * FROM agent_starts WHERE session_id = ? ORDER BY started_at, rowid').all(sessionId) as Record<string, unknown>[]
    return rows.map(mapStart)
  }

  /** A memory state's per-file hashes, null when unknown. */
  manifest(memoryHash: string): Record<string, string> | null {
    const row = this.db.prepare('SELECT files FROM memory_manifests WHERE memory_hash = ?').get(memoryHash) as { files: string } | null
    return row ? JSON.parse(row.files) as Record<string, string> : null
  }
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value))

export function mapStart(row: Record<string, unknown>): AgentStartRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    teamId: text(row.team_id),
    groupId: text(row.group_id),
    profileId: text(row.profile_id),
    model: text(row.model),
    effort: text(row.effort),
    cwd: String(row.cwd),
    groupFileHash: text(row.group_file_hash),
    promptAppendHash: text(row.prompt_append_hash),
    memoryHash: text(row.memory_hash),
    memoryFiles: row.memory_files === null || row.memory_files === undefined ? null : Number(row.memory_files),
    instructionsHash: text(row.instructions_hash),
    unavailable: row.unavailable ? JSON.parse(String(row.unavailable)) as string[] : [],
    startedAt: String(row.started_at),
  }
}
