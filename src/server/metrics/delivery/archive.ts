// D3 archive arrivals are first positions, independent of log output order.
// The directory date is text only; the landing's timestamp comes from Git.
import { isFullLiteral } from './objectFormat'
import type { Landing, LandingPositions, ObjectFormat } from './types'

export type ChangeLandings =
  | { ok: true; changes: ReadonlyMap<string, Landing> }
  | { ok: false; reason: 'archive-malformed' }

const ARCHIVE_PATH = /^openspec\/changes\/archive\/([0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*)\/proposal\.md$/

/** Parse D1 read 2 as a whole; no malformed path is silently excluded. */
export function changeLandings(text: string, positions: LandingPositions, format: ObjectFormat): ChangeLandings {
  const chain = new Map(positions.chain.map(commit => [commit.sha, commit]))
  const changes = new Map<string, Landing>()
  let current: Landing | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    if (line.startsWith('@')) {
      const sha = line.slice(1)
      if (!isFullLiteral(sha, format) || !chain.has(sha)) return { ok: false, reason: 'archive-malformed' }
      current = chain.get(sha)!
      continue
    }
    const match = ARCHIVE_PATH.exec(line)
    if (current === undefined || match === null) return { ok: false, reason: 'archive-malformed' }
    const name = match[1]!.slice(11)
    const earlier = changes.get(name)
    if (earlier === undefined || current.position < earlier.position) {
      changes.set(name, { position: current.position, at: current.at, bound: current.bound })
    }
  }
  return { ok: true, changes }
}
