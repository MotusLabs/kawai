// Target versions (team-process-metrics D6), derived at read time and never
// stored. A target is one group's file or one shared memory file; its starts
// are, in `started_at` then id order, every start of the group's members (a
// group target) or every start of the team (a memory target), each with the
// hash it loaded at the target's own granularity: the group file hash, or
// that one file's hash from the start's memory manifest (null = absent).
// Starts that could not read the input are skipped — they say nothing about
// its version. A version change is a start whose hash differs from the
// previous start's; a hash may recur (A → B → A is two changes), and the
// first start ever recorded is not a change.
import type { Database } from 'bun:sqlite'
import type { ProposalTargetKind, VersionChange } from '../../shared/processReports'

export interface TargetStart {
  startId: string
  sessionId: string
  at: string
  hash: string | null
}

export const targetKey = (kind: ProposalTargetKind, target: string) => `${kind}:${target}`

interface StartRow {
  id: string
  session_id: string
  group_id: string | null
  group_file_hash: string | null
  memory_hash: string | null
  unavailable: string | null
  started_at: string
}

/** Every target's starts in the team: groups by id, memory files by name. */
export function loadTargetStarts(db: Database, teamId: string): Map<string, TargetStart[]> {
  const rows = db.prepare(`SELECT id, session_id, group_id, group_file_hash, memory_hash, unavailable, started_at
    FROM agent_starts WHERE team_id = ? ORDER BY started_at, id`).all(teamId) as StartRow[]
  const manifests = new Map<string, Record<string, string>>()
  for (const row of db.prepare(`SELECT memory_hash, files FROM memory_manifests WHERE memory_hash IN
    (SELECT DISTINCT memory_hash FROM agent_starts WHERE team_id = ? AND memory_hash IS NOT NULL)`).all(teamId) as Array<{ memory_hash: string; files: string }>) {
    manifests.set(row.memory_hash, JSON.parse(row.files) as Record<string, string>)
  }
  const memoryFiles = new Set<string>()
  for (const files of manifests.values()) for (const name of Object.keys(files)) memoryFiles.add(name)
  const out = new Map<string, TargetStart[]>()
  const push = (key: string, start: TargetStart) => {
    const list = out.get(key) ?? []
    list.push(start)
    out.set(key, list)
  }
  for (const row of rows) {
    const unavailable = row.unavailable ? JSON.parse(row.unavailable) as string[] : []
    const base = { startId: row.id, sessionId: row.session_id, at: row.started_at }
    if (row.group_id && !unavailable.includes('group_file')) push(targetKey('group', row.group_id), { ...base, hash: row.group_file_hash })
    if (unavailable.includes('memory')) continue
    const files = row.memory_hash ? manifests.get(row.memory_hash) ?? {} : {}
    for (const name of memoryFiles) push(targetKey('memory', name), { ...base, hash: files[name] ?? null })
  }
  return out
}

/** The starts of one target, in order. */
export function targetStarts(db: Database, teamId: string, kind: ProposalTargetKind, target: string): TargetStart[] {
  return loadTargetStarts(db, teamId).get(targetKey(kind, target)) ?? []
}

/** The target's version changes: each start whose hash differs from the previous start's. */
export function versionChanges(kind: ProposalTargetKind, target: string, starts: readonly TargetStart[]): VersionChange[] {
  const changes: VersionChange[] = []
  for (let i = 1; i < starts.length; i++) {
    const previous = starts[i - 1]!
    const start = starts[i]!
    if (start.hash !== previous.hash) {
      changes.push({ targetKind: kind, target, startId: start.startId, sessionId: start.sessionId, at: start.at, hash: start.hash, previousHash: previous.hash })
    }
  }
  return changes
}

/** The newest recorded hash; undefined when no start ever loaded the target. */
export function latestHash(starts: readonly TargetStart[]): string | null | undefined {
  return starts.length === 0 ? undefined : starts.at(-1)!.hash
}
