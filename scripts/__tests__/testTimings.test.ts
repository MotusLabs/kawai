import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SLOW_TIER_EXCEPTIONS,
  TIMINGS_FILE_NAME,
  formatMisplacedReport,
  misplacedFiles,
  parseTimingsRecord,
  publishTimingsSnapshot,
  readTimingsSeed,
  seedTimingsSnapshot,
} from '../testTimings'
import { isSlowTierFile } from '../planBatches'

function makeRecordsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timings-records-'))
}

const RECORD = JSON.stringify({
  version: 1,
  files: { './src/server/__tests__/a.test.ts': 12_345, './src/client/__tests__/b.test.tsx': 678 },
})

describe('parseTimingsRecord', () => {
  test('accepts the recorded shape', () => {
    const record = parseTimingsRecord(RECORD)
    expect(record).toEqual({
      version: 1,
      files: { './src/server/__tests__/a.test.ts': 12_345, './src/client/__tests__/b.test.tsx': 678 },
    })
  })

  test('refuses malformed JSON, other versions, and wrongly shaped files', () => {
    expect(parseTimingsRecord('{not json')).toBeNull()
    expect(parseTimingsRecord('')).toBeNull()
    expect(parseTimingsRecord('[]')).toBeNull()
    expect(parseTimingsRecord('{"version":2,"files":{}}')).toBeNull()
    expect(parseTimingsRecord('{"version":1}')).toBeNull()
    expect(parseTimingsRecord('{"version":1,"files":[]}')).toBeNull()
    expect(parseTimingsRecord('{"version":1,"files":{"a.test.ts":"fast"}}')).toBeNull()
    expect(parseTimingsRecord('{"version":1,"files":{"a.test.ts":-5}}')).toBeNull()
  })
})

describe('readTimingsSeed', () => {
  test('a missing or malformed record is no seed and never throws', () => {
    const dir = makeRecordsDir()
    expect(readTimingsSeed(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, TIMINGS_FILE_NAME), '{torn')
    expect(readTimingsSeed(dir)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a valid record is returned verbatim', () => {
    const dir = makeRecordsDir()
    fs.writeFileSync(path.join(dir, TIMINGS_FILE_NAME), RECORD)
    expect(readTimingsSeed(dir)).toBe(RECORD)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('seedTimingsSnapshot', () => {
  test('seeds the snapshot with the record and leaves it absent without one', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    const seeded = seedTimingsSnapshot(runRoot, RECORD)
    expect(fs.readFileSync(seeded, 'utf8')).toBe(RECORD)
    fs.rmSync(runRoot, { recursive: true, force: true })

    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    const bare = seedTimingsSnapshot(bareRoot, null)
    expect(path.dirname(bare)).toBe(bareRoot)
    expect(fs.existsSync(bare)).toBe(false)
    fs.rmSync(bareRoot, { recursive: true, force: true })
  })
})

describe('publishTimingsSnapshot', () => {
  test('renames the parsed snapshot into place', () => {
    const dir = makeRecordsDir()
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    const snapshot = path.join(runRoot, TIMINGS_FILE_NAME)
    // Both keys name real files of this repository, so the default
    // existence check keeps them.
    fs.writeFileSync(
      snapshot,
      JSON.stringify({
        version: 1,
        files: { './scripts/planBatches.ts': 12_345, './scripts/test-runner.ts': 678 },
      })
    )
    const record = publishTimingsSnapshot(dir, snapshot)
    expect(record).toEqual({
      version: 1,
      files: { './scripts/planBatches.ts': 12_345, './scripts/test-runner.ts': 678 },
    })
    expect(parseTimingsRecord(fs.readFileSync(path.join(dir, TIMINGS_FILE_NAME), 'utf8'))).toEqual(record)
    expect(fs.readdirSync(dir)).toEqual([TIMINGS_FILE_NAME])
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(runRoot, { recursive: true, force: true })
  })

  test('a missing or malformed snapshot leaves the previous record standing', () => {
    const dir = makeRecordsDir()
    fs.writeFileSync(path.join(dir, TIMINGS_FILE_NAME), RECORD)
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    expect(publishTimingsSnapshot(dir, path.join(runRoot, 'absent.json'))).toBeNull()
    const torn = path.join(runRoot, TIMINGS_FILE_NAME)
    fs.writeFileSync(torn, '{torn')
    expect(publishTimingsSnapshot(dir, torn)).toBeNull()
    expect(readTimingsSeed(dir)).toBe(RECORD)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(runRoot, { recursive: true, force: true })
  })

  test('drops keys whose file no longer exists', () => {
    const dir = makeRecordsDir()
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    const snapshot = path.join(runRoot, TIMINGS_FILE_NAME)
    fs.writeFileSync(
      snapshot,
      JSON.stringify({
        version: 1,
        files: { './src/server/__tests__/renamed-away.test.ts': 9_000, './scripts/planBatches.ts': 10 },
      })
    )
    const record = publishTimingsSnapshot(dir, snapshot, (file) => file === 'scripts/planBatches.ts')
    // The key keeps the spelling bun recorded; only the ghost is dropped.
    expect(record).toEqual({ version: 1, files: { './scripts/planBatches.ts': 10 } })
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(runRoot, { recursive: true, force: true })
  })

  test('concurrent writers never expose partial JSON', async () => {
    const dir = makeRecordsDir()
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    // Two writer processes, like two suite-run slots publishing at once. The
    // payloads are large enough that a non-atomic write would open a window
    // a reader could catch: the contract is that every read of the record
    // parses or finds no file, never an empty or torn one.
    const writerScript = `
      const { publishTimingsSnapshot } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../testTimings.ts'))})
      const end = Date.now() + Number(process.env.WRITER_MS)
      while (Date.now() < end) publishTimingsSnapshot(process.env.WRITER_DIR, process.env.WRITER_SNAPSHOT)
    `
    const snapshots = [0, 1].map((writer) => {
      const snapshot = path.join(runRoot, `writer-${writer}.json`)
      fs.writeFileSync(
        snapshot,
        JSON.stringify({
          version: 1,
          files: Object.fromEntries(
            Array.from({ length: 2_000 }, (_, i) => [
              `./src/server/__tests__/w${writer}f${i}.test.ts`,
              i * 100,
            ])
          ),
        })
      )
      return snapshot
    })
    const writers = snapshots.map((snapshot) =>
      Bun.spawn([process.execPath, '-e', writerScript], {
        stdout: 'ignore',
        stderr: 'inherit',
        env: { ...process.env, WRITER_DIR: dir, WRITER_SNAPSHOT: snapshot, WRITER_MS: '1500' },
      })
    )
    let reads = 0
    let missing = 0
    let poisoned: string | null = null
    // The writers run 1.5 s; the reader polls past their deadline so the
    // last rename is also observed.
    const deadline = Date.now() + 1_700
    while (Date.now() < deadline) {
      try {
        const text = fs.readFileSync(path.join(dir, TIMINGS_FILE_NAME), 'utf8')
        reads += 1
        if (parseTimingsRecord(text) === null) poisoned = text
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing += 1
        else throw error
      }
      await Bun.sleep(0)
    }
    await Promise.all(writers.map((writer) => writer.exited))
    expect(poisoned, `a reader saw partial JSON: ${String(poisoned).slice(0, 80)}`).toBeNull()
    expect(reads).toBeGreaterThan(0)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(runRoot, { recursive: true, force: true })
  }, 20_000)
})

describe('misplacedFiles', () => {
  const files = {
    './src/server/__tests__/bigMatrix.test.ts': 19_900,
    './src/server/__tests__/listed.test.ts': 12_000,
    './src/server/__tests__/quick.test.ts': 4_999,
    './src/server/__tests__/teamTasks.integration.test.ts': 30_000,
    './src/server/__tests__/integration.test.ts': 30_000,
  }

  test('a slow unlisted file outside the tier is reported; a slow listed one is not', () => {
    const misplaced = misplacedFiles({
      files,
      isSlowTier: isSlowTierFile,
      exceptions: [{ file: 'src/server/__tests__/listed.test.ts', reason: 'a matrix whose assertions need its size' }],
    })
    expect(misplaced).toEqual([{ file: 'src/server/__tests__/bigMatrix.test.ts', ms: 19_900 }])
  })

  test('a file at or under 5 s is not, and tier files never are', () => {
    const misplaced = misplacedFiles({ files, isSlowTier: isSlowTierFile })
    expect(misplaced.map((entry) => entry.file)).toEqual([
      'src/server/__tests__/bigMatrix.test.ts',
      'src/server/__tests__/listed.test.ts',
    ])
  })

  test('the exception matches by basename whatever the key spelling', () => {
    const misplaced = misplacedFiles({
      files: { 'bigMatrix.test.ts': 19_900 },
      isSlowTier: isSlowTierFile,
      exceptions: [{ file: 'src/server/__tests__/bigMatrix.test.ts', reason: 'listed' }],
    })
    expect(misplaced).toEqual([])
  })

  test('the report formats dispositions, or a quiet confirmation', () => {
    const lines = formatMisplacedReport([{ file: 'src/server/__tests__/bigMatrix.test.ts', ms: 19_900 }])
    expect(lines[0]).toContain('1 file(s) over 5 s')
    expect(lines[1]).toContain('19.9 s')
    expect(lines[1]).toContain('bigMatrix.test.ts')
    expect(formatMisplacedReport([])).toEqual([
      '[test-runner] timings: no file over 5 s sits outside the slow tier',
    ])
  })
})

describe('SLOW_TIER_EXCEPTIONS', () => {
  test('every entry names an existing non-tier file, once', () => {
    const seen = new Set<string>()
    for (const entry of SLOW_TIER_EXCEPTIONS) {
      expect(entry.reason.trim()).not.toBe('')
      expect(seen, `${entry.file} listed twice`).not.toContain(entry.file)
      seen.add(entry.file)
      // A stale entry (file renamed or deleted) must fail here, not hide in
      // the report forever.
      expect(fs.existsSync(entry.file), `${entry.file} no longer exists`).toBe(true)
      expect(isSlowTierFile(entry.file), `${entry.file} belongs to the slow tier now`).toBe(false)
    }
    expect(SLOW_TIER_EXCEPTIONS.length).toBeGreaterThan(50)
  })
})
