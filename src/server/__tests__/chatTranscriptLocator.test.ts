// Transcript discovery without a walk per lookup (`transcriptLocator.ts`,
// bounded-boot-restore D1/D4), as the design's Tables L and K plus property
// P2: the boot index names what `findTranscriptPath` would find for each id
// (nested dirs, newest duplicate in either walk order, ties, depth limit,
// non-transcripts ignored), and the start blocker's path cache reuses an
// existing path, re-walks once the file is gone, and never remembers a miss.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { indexTranscripts, TranscriptPathCache } from '../chat/transcriptLocator'
import { findTranscriptPath } from '../chat/transcriptReplay'

let configDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-locator-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  fs.rmSync(configDir, { recursive: true, force: true })
})

function put(relative: string, mtimeSec?: number): string {
  const file = path.join(configDir, 'projects', relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}\n')
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec)
  return file
}

async function expectIndexParity(ids: string[]): Promise<Map<string, string>> {
  const index = await indexTranscripts()
  for (const id of ids) expect(index.get(`${id}.jsonl`) ?? null).toBe(findTranscriptPath(id))
  return index
}

// Table L — `indexTranscripts().get(name)` equals `findTranscriptPath(id)`.
const TABLE_L: Array<{ id: string; files: Array<[string, number?]>; lookup: string; expected: string | null }> = [
  { id: 'L1 one copy at depth ≤ 3, subagents included', files: [['-a/one.jsonl'], ['-a/one/subagents/agent-x.jsonl']], lookup: 'agent-x', expected: '-a/one/subagents/agent-x.jsonl' },
  { id: 'L2 newest copy found second wins', files: [['-b/two.jsonl', 1_000], ['-c/two.jsonl', 2_000]], lookup: 'two', expected: '-c/two.jsonl' },
  { id: 'L2 newest copy found first wins', files: [['-b/four.jsonl', 2_000], ['-c/four.jsonl', 1_000]], lookup: 'four', expected: '-b/four.jsonl' },
  { id: 'L3 equal mtimes keep the first found', files: [['-d/three.jsonl', 2_000], ['-e/three.jsonl', 2_000]], lookup: 'three', expected: null },
  { id: 'L4 below depth 3 is absent', files: [['-a/b/c/d/deep.jsonl']], lookup: 'deep', expected: null },
  { id: 'L5 a non-jsonl file is absent', files: [['-a/notes.txt']], lookup: 'notes', expected: null },
]

describe('Table L — indexTranscripts', () => {
  for (const row of TABLE_L) {
    test(row.id, async () => {
      for (const [file, mtime] of row.files) put(file, mtime)
      const index = await expectIndexParity([row.lookup, 'none'])
      // L3's winner is the walk order's first, which `findTranscriptPath` names.
      if (row.expected !== null) expect(index.get(`${row.lookup}.jsonl`)).toBe(path.join(configDir, 'projects', row.expected))
      if (row.id.startsWith('L4') || row.id.startsWith('L5')) expect(index.size).toBe(0)
    })
  }

  test('L6 an absent projects root is an empty index', async () => {
    expect((await indexTranscripts()).size).toBe(0)
  })

  test('P2 matches findTranscriptPath over seeded random trees', async () => {
    let seed = 0x1de5
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return (seed >>> 16) % n
    }
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const dirs = ['-p', '-q', '-p/x', '-q/a/subagents', '-p/x/y/z', '-r/s/t']
    for (let round = 0; round < 40; round += 1) {
      fs.rmSync(path.join(configDir, 'projects'), { recursive: true, force: true })
      const count = rand(31)
      for (let i = 0; i < count; i += 1) {
        const dir = dirs[rand(dirs.length)]
        const name = rand(6) === 0 ? `${ids[rand(ids.length)]}.txt` : `${ids[rand(ids.length)]}.jsonl`
        put(`${dir}/${name}`, [1_000, 2_000, 3_000][rand(3)])
      }
      await expectIndexParity(ids)
    }
  })
})

// Table K — `TranscriptPathCache.existing`: result and walk count.
describe('Table K — TranscriptPathCache', () => {
  test('K1 a remembered existing path is reused without a walk', () => {
    let walks = 0
    const cache = new TranscriptPathCache(() => { walks += 1; return '/t/other.jsonl' }, () => true)
    cache.remember('a', '/t/a.jsonl')
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(walks).toBe(0)
  })

  // @covers: chat-sessions › Transcript-missing checks see the transcript's current presence › A deleted transcript is reported missing
  test('K2 a remembered path that is gone re-walks once and remembers the find', () => {
    const present = new Set(['/t/new.jsonl'])
    let walks = 0
    const cache = new TranscriptPathCache(() => { walks += 1; return '/t/new.jsonl' }, file => present.has(file))
    cache.remember('a', '/t/old.jsonl')
    expect(cache.existing('a')).toBe('/t/new.jsonl')
    expect(cache.existing('a')).toBe('/t/new.jsonl')
    expect(walks).toBe(1)
  })

  test('K3 a miss returns null and is not remembered', () => {
    let walks = 0
    const cache = new TranscriptPathCache(() => { walks += 1; return null }, () => true)
    expect(cache.existing('a')).toBeNull()
    expect(cache.existing('a')).toBeNull()
    expect(walks).toBe(2)
  })

  // @covers: chat-sessions › Transcript-missing checks see the transcript's current presence › A restored transcript is found
  test('K4 a transcript found after a miss is remembered', () => {
    let found: string | null = null
    let walks = 0
    const cache = new TranscriptPathCache(() => { walks += 1; return found }, () => true)
    expect(cache.existing('a')).toBeNull()
    found = '/t/a.jsonl'
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(walks).toBe(2)
  })

  test('K2/K3 with the real walk and file check', () => {
    const cache = new TranscriptPathCache()
    expect(cache.existing('real')).toBeNull()
    const file = put('-p/real.jsonl')
    expect(cache.existing('real')).toBe(file)
    fs.rmSync(file)
    expect(cache.existing('real')).toBeNull()
  })
})
