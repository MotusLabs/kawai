// Pure validation of supplied complete log text. Actual Git/transport/lifecycle
// and publication remain held. Accepted1.1 derivations are reused, not modelled.
import { changeLandings } from './archive'
import { commitTimeMs, landingPositions } from './landing'
import { isFullLiteral } from './objectFormat'
import { DeliveryHistoryError } from './types'
import type { CommitGraph, HistoryCommit, LandingPositions, ObjectFormat } from './types'

export interface ParsedHistory {
  readonly graph: CommitGraph
  readonly positions: LandingPositions
  readonly integrationCount: number
}

function malformed(): never { throw new DeliveryHistoryError('history-malformed') }

export function parseCompleteGraph(text: string, H: string, format: ObjectFormat): ParsedHistory {
  if (!isFullLiteral(H, format)) return malformed()
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) return malformed()
  const graph = new Map<string, HistoryCommit>()
  for (const line of lines) {
    const row = /^([0-9a-f]+) (-?(?:0|[1-9][0-9]*))(?: ((?:[0-9a-f]+(?: [0-9a-f]+)*)?))?$/.exec(line)
    if (row === null || !isFullLiteral(row[1], format) || graph.has(row[1])) return malformed()
    const parents = row[3] ? row[3].split(' ') : []
    if (parents.some(parent => !isFullLiteral(parent, format)) || new Set(parents).size !== parents.length) return malformed()
    graph.set(row[1], Object.freeze({ committedAt: commitTimeMs(Number(row[2])), parents: Object.freeze(parents) }))
  }
  if (graph.keys().next().value !== H) return malformed()
  for (const commit of graph.values()) {
    if (commit.parents.some(parent => !graph.has(parent))) throw new DeliveryHistoryError('history-incomplete')
  }
  const colors = new Map<string, 'visiting' | 'done'>()
  const pending: { sha: string; finish: boolean }[] = [{ sha: H, finish: false }]
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (entry.finish) { colors.set(entry.sha, 'done'); continue }
    if (colors.get(entry.sha) === 'visiting') return malformed()
    if (colors.has(entry.sha)) continue
    colors.set(entry.sha, 'visiting')
    pending.push({ sha: entry.sha, finish: true })
    for (const parent of graph.get(entry.sha)!.parents) pending.push({ sha: parent, finish: false })
  }
  if (colors.size !== graph.size) return malformed()
  const positions = landingPositions(graph, H)
  return Object.freeze({ graph, positions, integrationCount: positions.chain.length })
}

export function validateArchiveHistory(text: string, history: ParsedHistory, format: ObjectFormat) {
  return changeLandings(text, history.positions, format)
}
