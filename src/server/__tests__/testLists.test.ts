// testLists.test.ts - The test-list format beside a full-check record
// (independent-verification D7, task 4.2): one sorted entry shape, written
// before the record, read fail-closed — a missing, unreadable, malformed,
// or mismatched list is null (run unknown), never fabricated data (K1,
// K4). The writer and reader share this module's comparator and validator
// (C1 advisor point 3), so every case here is both sides' case.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  compareTestListEntries,
  parseTestList,
  readTestList,
  recordTestList,
  removeTestList,
  testListName,
  testListPath,
  writeTestList,
  type TestListEntry,
} from '../checks/testLists'
import { writeRecord, type CheckRecord } from '../checks/checkRecords'

let dir: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-test-lists-')))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function entry(over: Partial<TestListEntry> = {}): TestListEntry {
  return { file: 'src/a.test.ts', path: 'outer > inner', name: 'passes', status: 'passed', ...over }
}

function record(key: string, count: number): CheckRecord {
  return {
    key,
    treeId: 't',
    bun: '1.4.3',
    platform: 'linux',
    arch: 'x64',
    at: new Date().toISOString(),
    worktree: dir,
    steps: [],
    tests: { file: testListName(key), count },
  }
}

const KEY = 'a'.repeat(64)

describe('a written list reads back whole (K4)', () => {
  // @covers: dev-checks › Full-check records list the tests that ran › Pass with its test list
  test('writeTestList sorts with the shared comparator and readTestList returns the entries', () => {
    const entries = [
      entry({ file: 'src/b.test.ts', name: 'zeta' }),
      entry({ name: 'alpha', path: '' }),
      entry({ name: 'beta', status: 'todo' }),
    ]
    writeTestList(dir, KEY, entries)
    const read = readTestList(dir, record(KEY, 3))
    expect(read).toEqual([...entries].sort(compareTestListEntries))
    expect(read?.map((one) => one.name)).toEqual(['alpha', 'beta', 'zeta'])
  })

  test('every status of the union survives the round trip', () => {
    const entries = [entry(), entry({ name: 'skipped one', status: 'skipped' }), entry({ name: 'a todo', status: 'todo' })]
    writeTestList(dir, KEY, entries)
    // The reader requires the writer's sort: same file and path, so by name.
    expect(readTestList(dir, record(KEY, 3))?.map((one) => [one.name, one.status])).toEqual([
      ['a todo', 'todo'],
      ['passes', 'passed'],
      ['skipped one', 'skipped'],
    ])
  })
})

describe('a missing or damaged list reads as unknown, never fabricated (K1)', () => {
  test('the parser itself refuses non-arrays and unsorted arrays', () => {
    expect(parseTestList('{"nope": true}')).toBeNull()
    expect(parseTestList(JSON.stringify([entry({ name: 'zeta' }), entry({ name: 'alpha' })]))).toBeNull()
    expect(parseTestList(JSON.stringify([entry({ name: 'alpha' }), entry()]))).toEqual([
      entry({ name: 'alpha' }),
      entry(),
    ])
  })

  test('no list file at all', () => {
    expect(readTestList(dir, record(KEY, 0))).toBeNull()
  })

  test('a corrupt gz body', () => {
    writeTestList(dir, KEY, [entry()])
    fs.writeFileSync(testListPath(dir, KEY), Buffer.from('not gzip at all'))
    expect(readTestList(dir, record(KEY, 1))).toBeNull()
  })

  test('a truncated list (count disagrees with the array)', () => {
    writeTestList(dir, KEY, [entry(), entry({ name: 'second' })])
    // Simulate a torn rewrite: the list now holds one entry, the record still says two.
    fs.writeFileSync(testListPath(dir, KEY), gzipSync(Buffer.from(JSON.stringify([entry()]))))
    expect(readTestList(dir, record(KEY, 2))).toBeNull()
  })

  test('a gz of valid JSON that is not a list', () => {
    fs.writeFileSync(testListPath(dir, KEY), gzipSync(Buffer.from(JSON.stringify({ nope: true }))))
    expect(readTestList(dir, record(KEY, 1))).toBeNull()
  })

  test('an entry with a status outside the union', () => {
    fs.writeFileSync(testListPath(dir, KEY), gzipSync(Buffer.from(JSON.stringify([{ ...entry(), status: 'failed' }]))))
    expect(readTestList(dir, record(KEY, 1))).toBeNull()
  })

  test('an unsorted array', () => {
    const entries = [entry({ name: 'zeta' }), entry({ name: 'alpha' })]
    fs.writeFileSync(testListPath(dir, KEY), gzipSync(Buffer.from(JSON.stringify(entries))))
    expect(readTestList(dir, record(KEY, 2))).toBeNull()
  })

  test('a list decompressing over the size cap reads as unknown (C2 advisory b)', () => {
    // The decompressed-size cap bounds read-time memory; over it the answer
    // is null, never a throw into the caller. The body is otherwise a valid
    // one-entry list (trailing JSON whitespace parses fine and the count
    // agrees), so only the cap can refuse it.
    const one = JSON.stringify([entry()])
    const padded = Buffer.from(one + ' '.repeat(33 * 1024 * 1024 - one.length), 'utf8')
    fs.writeFileSync(testListPath(dir, KEY), gzipSync(padded))
    expect(readTestList(dir, record(KEY, 1))).toBeNull()
  })
})

describe('a mismatched record pointer reads as unknown (K1, C1 advisor point 3)', () => {
  // @covers: dev-checks › Full-check records list the tests that ran › Record without a list
  test('a record without tests reads as no list (records written before this change)', () => {
    writeTestList(dir, KEY, [entry()])
    const listless = { ...record(KEY, 1), tests: undefined }
    expect(recordTestList(listless)).toBeNull()
    expect(readTestList(dir, listless as CheckRecord)).toBeNull()
  })

  test('a pointer naming another key\'s list file fails closed', () => {
    writeTestList(dir, KEY, [entry()])
    // The b-key record's tests field names the a-key list file.
    const other = { ...record('b'.repeat(64), 1), tests: { file: testListName(KEY), count: 1 } }
    fs.writeFileSync(testListPath(dir, other.key), fs.readFileSync(testListPath(dir, KEY)))
    expect(readTestList(dir, other)).toBeNull()
  })

  test('a pointer with a non-integer count fails closed', () => {
    const bad = { ...record(KEY, 1), tests: { file: testListName(KEY), count: 1.5 } } as CheckRecord
    expect(recordTestList(bad)).toBeNull()
    expect(readTestList(dir, bad)).toBeNull()
  })
})

describe('the writer refuses and cleans up what it owns', () => {
  test('writeTestList refuses a non-key name', () => {
    expect(() => writeTestList(dir, '../escape', [entry()])).toThrow(/non-key/)
  })

  test('removeTestList is best-effort and removes an existing list', () => {
    writeTestList(dir, KEY, [entry()])
    removeTestList(dir, KEY)
    expect(fs.existsSync(testListPath(dir, KEY))).toBe(false)
    expect(() => removeTestList(dir, KEY)).not.toThrow()
    expect(() => removeTestList(dir, 'zz')).not.toThrow()
  })

  test('a written list is stored gzipped (the record names the .tests.json.gz file)', () => {
    writeTestList(dir, KEY, [entry()])
    const raw = fs.readFileSync(testListPath(dir, KEY))
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  })
})

describe('the record write path stores the list before the record can point at it', () => {
  test('writeRecord keeps the tests pointer and readRecord hands it back', () => {
    writeTestList(dir, KEY, [entry(), entry({ name: 'two' })])
    const full = record(KEY, 2)
    writeRecord(dir, full)
    const reread = JSON.parse(fs.readFileSync(path.join(dir, `${KEY}.json`), 'utf8')) as CheckRecord
    expect(reread.tests).toEqual({ file: testListName(KEY), count: 2 })
    expect(readTestList(dir, full)).toHaveLength(2)
  })

  test('a record written before lists keeps reading (no tests field, no list)', () => {
    const legacy = record(KEY, 0)
    delete (legacy as Partial<CheckRecord>).tests
    writeRecord(dir, legacy)
    const reread = JSON.parse(fs.readFileSync(path.join(dir, `${KEY}.json`), 'utf8')) as CheckRecord
    expect(reread.tests).toBeUndefined()
    expect(readTestList(dir, reread)).toBeNull()
  })
})
