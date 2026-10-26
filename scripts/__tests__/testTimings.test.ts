import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  KEPT_RUN_SNAPSHOTS,
  SLOW_TIER_EXCEPTIONS,
  TIMINGS_FILE_NAME,
  formatMisplacedReport,
  isRunSnapshotName,
  loadTimingSamples,
  misplacedFiles,
  misplacedFromRecords,
  parseTimingsRecord,
  pruneRunSnapshots,
  publishTimingsSnapshot,
  readTimingsSeed,
  seedTimingsSnapshot,
  shortestAcross,
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
    // The run's own snapshot (D7) sits beside the record, and both parse.
    const written = fs.readdirSync(dir)
    expect(written.length).toBe(2)
    expect(written).toContain(TIMINGS_FILE_NAME)
    const snapshotName = written.find((name) => name !== TIMINGS_FILE_NAME)
    expect(snapshotName, 'the run snapshot is the second file').toBeDefined()
    expect(isRunSnapshotName(snapshotName!)).toBe(true)
    expect(parseTimingsRecord(fs.readFileSync(path.join(dir, snapshotName!), 'utf8'))).toEqual(record)
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

  test('concurrent writers never expose partial JSON, and both leave whole run snapshots', async () => {
    const dir = makeRecordsDir()
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'timings-runroot-'))
    // Two writer processes, like two suite-run slots publishing at once. The
    // predicate keeps every key, so each written record is the full payload:
    // large enough that a non-atomic write would open a window a reader
    // could catch. The contract is that every read of the record or of a
    // run snapshot parses or finds no file, never an empty or torn one, and
    // that each publisher's snapshot survives the other's pruning (D7).
    const writerScript = `
      const { publishTimingsSnapshot } = await import(${JSON.stringify(path.resolve(import.meta.dir, '../testTimings.ts'))})
      const end = Date.now() + Number(process.env.WRITER_MS)
      while (Date.now() < end)
        publishTimingsSnapshot(process.env.WRITER_DIR, process.env.WRITER_SNAPSHOT, () => true)
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
    let poisoned: string | null = null
    let poisonedSnapshot: string | null = null
    const seenPublishers = new Set<string>()
    // The writers run 1.5 s; the reader polls past their deadline so the
    // last rename is also observed.
    const deadline = Date.now() + 1_700
    while (Date.now() < deadline) {
      try {
        const text = fs.readFileSync(path.join(dir, TIMINGS_FILE_NAME), 'utf8')
        reads += 1
        if (parseTimingsRecord(text) === null) poisoned = text
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // Every run snapshot ever observed must parse whole, and both
      // publishers' snapshots must appear (pruning may remove older ones;
      // a name listed then unlinked before the read is a prune race, not a
      // torn file).
      let names: string[] = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        // directory not created yet
      }
      for (const name of names) {
        if (!isRunSnapshotName(name)) continue
        seenPublishers.add(name.replace(/^timings-\d{8}T\d{6}Z-/, '').replace(/\.json$/, ''))
        try {
          const text = fs.readFileSync(path.join(dir, name), 'utf8')
          if (parseTimingsRecord(text) === null) poisonedSnapshot = name
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await Bun.sleep(0)
    }
    await Promise.all(writers.map((writer) => writer.exited))
    expect(poisoned, `a reader saw partial JSON: ${String(poisoned).slice(0, 80)}`).toBeNull()
    expect(poisonedSnapshot, `a reader saw a torn run snapshot: ${String(poisonedSnapshot)}`).toBeNull()
    expect(reads).toBeGreaterThan(0)
    expect(seenPublishers.size).toBe(2)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(runRoot, { recursive: true, force: true })
  }, 20_000)
})

describe('run snapshots and the shortest-duration rule (D7)', () => {
  function writeSample(dir: string, name: string, files: Record<string, number>): void {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, files }))
  }

  test('pruning keeps the newest five snapshots by name', () => {
    const dir = makeRecordsDir()
    for (let index = 1; index <= 7; index += 1) {
      const stamp = `20261022T00000${index}Z`
      writeSample(dir, `timings-${stamp}-1.json`, { './a.test.ts': index })
    }
    pruneRunSnapshots(dir)
    const kept = fs.readdirSync(dir).sort()
    expect(kept.length).toBe(KEPT_RUN_SNAPSHOTS)
    expect(kept[0]).toBe('timings-20261022T000003Z-1.json')
    expect(kept.at(-1)).toBe('timings-20261022T000007Z-1.json')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('the report judges the shortest kept duration: a load spike is not named, a durably slow file is', () => {
    const dir = makeRecordsDir()
    // c is over 5 s in the record and every kept run; a spikes over 5 s in
    // one kept run but is under 5 s in the other (and in the record).
    writeSample(dir, TIMINGS_FILE_NAME, { './src/a.test.ts': 4_000, './src/c.test.ts': 8_000 })
    writeSample(dir, 'timings-20261022T000001Z-1.json', {
      './src/a.test.ts': 6_500,
      './src/b.test.ts': 7_000,
      './src/c.test.ts': 8_100,
    })
    writeSample(dir, 'timings-20261022T000002Z-2.json', {
      './src/a.test.ts': 4_500,
      './src/b.test.ts': 7_500,
      './src/c.test.ts': 8_200,
    })
    const misplaced = misplacedFromRecords(dir, isSlowTierFile)
    // The report names normalized paths (the leading './' stripped).
    expect(misplaced).toEqual([
      { file: 'src/c.test.ts', ms: 8_000 },
      { file: 'src/b.test.ts', ms: 7_000 },
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a malformed snapshot is skipped, and the record alone judges when it is the only sample', () => {
    const dir = makeRecordsDir()
    writeSample(dir, TIMINGS_FILE_NAME, { './src/x.test.ts': 6_000 })
    fs.writeFileSync(path.join(dir, 'timings-20261022T000001Z-1.json'), '{torn')
    writeSample(dir, 'timings-20261022T000002Z-2.json', { './src/y.test.ts': 9_000 })
    // The torn snapshot contributes nothing: x is named only from the record,
    // and the whole snapshot still judges y.
    expect(loadTimingSamples(dir)).toEqual([
      { './src/x.test.ts': 6_000 },
      { './src/y.test.ts': 9_000 },
    ])
    expect(misplacedFromRecords(dir, isSlowTierFile)).toEqual([
      { file: 'src/y.test.ts', ms: 9_000 },
      { file: 'src/x.test.ts', ms: 6_000 },
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('no snapshots: the record alone is the judgment; no samples: nothing to judge', () => {
    const dir = makeRecordsDir()
    writeSample(dir, TIMINGS_FILE_NAME, { './src/x.test.ts': 6_000 })
    expect(loadTimingSamples(dir)).toEqual([{ './src/x.test.ts': 6_000 }])
    expect(misplacedFromRecords(dir, isSlowTierFile)).toEqual([{ file: 'src/x.test.ts', ms: 6_000 }])
    fs.rmSync(dir, { recursive: true, force: true })

    const empty = makeRecordsDir()
    expect(loadTimingSamples(empty)).toEqual([])
    expect(misplacedFromRecords(empty, isSlowTierFile)).toBeNull()
    fs.rmSync(empty, { recursive: true, force: true })
  })

  test('shortestAcross takes the minimum per file across samples', () => {
    expect(
      shortestAcross([
        { './a.test.ts': 6_000, './b.test.ts': 7_000 },
        { './a.test.ts': 4_500 },
        { './c.test.ts': 8_000 },
      ])
    ).toEqual({ './a.test.ts': 4_500, './b.test.ts': 7_000, './c.test.ts': 8_000 })
    expect(shortestAcross([])).toEqual({})
  })
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

// The per-entry integrity check (F4), extracted so it can be exercised on
// a synthetic list: the real SLOW_TIER_EXCEPTIONS is empty today, so the
// tripwire over the real list would iterate nothing and prove nothing.
// `seen` carries the files the earlier entries of one list already named.
function checkExceptionEntry(entry: { file: string; reason: string }, seen: Set<string>): void {
  expect(entry.reason.trim()).not.toBe('')
  expect(seen, `${entry.file} listed twice`).not.toContain(entry.file)
  seen.add(entry.file)
  // A stale entry (file renamed or deleted) must fail here, not hide in
  // the report forever.
  expect(fs.existsSync(entry.file), `${entry.file} no longer exists`).toBe(true)
  expect(isSlowTierFile(entry.file), `${entry.file} belongs to the slow tier now`).toBe(false)
  // Only a file over 5 s alone at N=1 may be listed (D7): the reason
  // states that measurement.
  expect(entry.reason, `${entry.file} states no N=1 time`).toMatch(/\d+(?:\.\d+)? s at N=1/)
}

describe('SLOW_TIER_EXCEPTIONS', () => {
  test('the per-entry check accepts a valid entry (F4)', () => {
    // The shape a listed entry must have: a real non-tier file and its
    // N=1 measurement.
    const valid = { file: 'src/shared/__tests__/chatTime.test.ts', reason: '9.4 s at N=1' }
    expect(() => checkExceptionEntry(valid, new Set())).not.toThrow()
  })

  test.each([
    [
      'a slow-tier file',
      new Set<string>(),
      { file: 'src/server/__tests__/codexRolloutReplay.integration.test.ts', reason: '9.4 s at N=1' },
      'belongs to the slow tier',
    ],
    [
      'a duplicate',
      new Set(['src/shared/__tests__/chatTime.test.ts']),
      { file: 'src/shared/__tests__/chatTime.test.ts', reason: '9.4 s at N=1' },
      'listed twice',
    ],
    ['an empty reason', new Set<string>(), { file: 'src/shared/__tests__/chatTime.test.ts', reason: '   ' }, null],
    [
      'a reason not in the N=1 format',
      new Set<string>(),
      { file: 'src/shared/__tests__/chatTime.test.ts', reason: 'measured slow' },
      'states no N=1 time',
    ],
    [
      'a missing file',
      new Set<string>(),
      { file: 'src/server/__tests__/noLongerThere.test.ts', reason: '9.4 s at N=1' },
      'no longer exists',
    ],
  ] as const)('the per-entry check rejects %s (F4)', (_name, seen, entry, message) => {
    if (message === null) expect(() => checkExceptionEntry(entry, seen)).toThrow()
    else expect(() => checkExceptionEntry(entry, seen)).toThrow(message)
  })

  test('every entry names an existing non-tier file, once, with its N=1 time', () => {
    const seen = new Set<string>()
    for (const entry of SLOW_TIER_EXCEPTIONS) checkExceptionEntry(entry, seen)
  })

  test('the renamed codex files belong to the slow tier now', () => {
    expect(isSlowTierFile('src/server/__tests__/codexRolloutReplay.integration.test.ts')).toBe(true)
    expect(isSlowTierFile('src/server/__tests__/codexTeamPath.integration.test.ts')).toBe(true)
    expect(fs.existsSync('src/server/__tests__/codexRolloutReplay.integration.test.ts')).toBe(true)
    expect(fs.existsSync('src/server/__tests__/codexTeamPath.integration.test.ts')).toBe(true)
    expect(fs.existsSync('src/server/__tests__/codexRolloutReplay.test.ts')).toBe(false)
    expect(fs.existsSync('src/server/__tests__/codexTeamPath.test.ts')).toBe(false)
  })
})
