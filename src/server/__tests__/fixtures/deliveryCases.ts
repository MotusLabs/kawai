// Pure, deterministic inputs for the L/I oracles, not an implementation model.
import type { CommitGraph, HistoryCommit } from '../../metrics/delivery/types'

export const id = (n: number, length = 40): string => n.toString(16).padStart(length, '0')
export const RESULT_CONTEXT = { teamId: 'fixture-team', taskId: 'fixture-task', resultId: 'fixture-result' }
export const FINISHED_AT = '2026-10-03T00:00:00.000Z'

export const passingCheck = (sha: string, seq = 1, checkId = 'fixture-check') => ({
  ...RESULT_CONTEXT, id: checkId, seq, finishedAt: FINISHED_AT, status: 'done',
  facts: { version: 1, commit: { status: 'pass', given: sha, sha } },
})

export function graphOf(rows: ReadonlyArray<readonly [number, number, ...number[]]>): CommitGraph {
  return new Map(rows.map(([n, committedAt, ...parents]) => [id(n), { committedAt, parents: parents.map(n => id(n)) }]))
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** Every generated head reaches ties, a backdated merge, and a side arrival. */
export function randomDag(random: () => number): { graph: CommitGraph; head: string } {
  const count = 30 + Math.floor(random() * 171)
  const graph = new Map<string, HistoryCommit>([
    [id(1), { committedAt: 100_000, parents: [] }],
    [id(2), { committedAt: 100_000, parents: [id(1)] }],
    [id(3), { committedAt: 70_000, parents: [id(1)] }],
    [id(4), { committedAt: 50_000, parents: [id(2), id(3)] }],
  ])
  for (let n = 5; n <= count; n++) {
    // First-parent paths always return through4, but differ in their length.
    const parents = [random() < 0.6 ? n - 1 : 4 + Math.floor(random() * (n - 4))]
    const wanted = 1 + Math.floor(random() * 3)
    while (parents.length < wanted) {
      const parent = 1 + Math.floor(random() * (n - 1))
      if (!parents.includes(parent)) parents.push(parent)
    }
    graph.set(id(n), { committedAt: Math.floor(random() * 1000) * 1000, parents: parents.map(n => id(n)) })
  }
  return { graph, head: id(count) }
}
