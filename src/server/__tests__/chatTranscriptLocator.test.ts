// Transcript discovery without a walk per lookup (`transcriptLocator.ts`):
// the boot index names what `findTranscriptPath` would find for each id
// (nested dirs, newest duplicate, depth limit, non-transcripts ignored), and
// the start blocker's path cache reuses an existing path, re-walks once the
// file is gone, and never remembers a miss.
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

describe('indexTranscripts', () => {
  test('names the same file findTranscriptPath finds, for every id', async () => {
    put('-a/one.jsonl')
    put('-a/one/subagents/agent-x.jsonl')
    put('-b/two.jsonl', 1_000)
    put('-c/two.jsonl', 2_000)
    put('-d/three.jsonl', 2_000)
    put('-e/three.jsonl', 2_000)
    put('-a/notes.txt')
    // Below the searched depth: neither reader sees it.
    put('-a/b/c/d/deep.jsonl')
    const index = await indexTranscripts()
    for (const id of ['one', 'agent-x', 'two', 'three', 'deep', 'none']) {
      expect(index.get(`${id}.jsonl`) ?? null).toBe(findTranscriptPath(id))
    }
    expect(index.get('two.jsonl')).toEndWith(path.join('-c', 'two.jsonl'))
    expect(index.has('notes.txt')).toBe(false)
  })

  test('an absent projects root is an empty index', async () => {
    expect((await indexTranscripts()).size).toBe(0)
  })
})

describe('TranscriptPathCache', () => {
  test('reuses an existing path without walking again', () => {
    let walks = 0
    const cache = new TranscriptPathCache(() => { walks += 1; return '/t/a.jsonl' }, () => true)
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(walks).toBe(1)
  })

  test('re-walks once the remembered file is gone', () => {
    const present = new Set(['/t/old.jsonl'])
    let next = '/t/new.jsonl'
    const cache = new TranscriptPathCache(() => next, file => present.has(file))
    cache.remember('a', '/t/old.jsonl')
    expect(cache.existing('a')).toBe('/t/old.jsonl')
    present.delete('/t/old.jsonl')
    present.add('/t/new.jsonl')
    expect(cache.existing('a')).toBe('/t/new.jsonl')
    next = '/t/other.jsonl'
    expect(cache.existing('a')).toBe('/t/new.jsonl')
  })

  test('never remembers a missing transcript', () => {
    let found: string | null = null
    let walks = 0
    const cache = new TranscriptPathCache(() => { walks += 1; return found }, () => true)
    expect(cache.existing('a')).toBeNull()
    expect(cache.existing('a')).toBeNull()
    found = '/t/a.jsonl'
    expect(cache.existing('a')).toBe('/t/a.jsonl')
    expect(walks).toBe(3)
  })

  test('defaults to the real walk and file check', () => {
    const cache = new TranscriptPathCache()
    expect(cache.existing('real')).toBeNull()
    const file = put('-p/real.jsonl')
    expect(cache.existing('real')).toBe(file)
    fs.rmSync(file)
    expect(cache.existing('real')).toBeNull()
  })
})
