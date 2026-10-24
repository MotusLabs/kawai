import { describe, expect, test } from 'bun:test'
import {
  REAL_TMUX_FILES,
  excludeSlowTier,
  isIntegrationFile,
  isRealTmuxFile,
  isSlowTierFile,
  planBatches,
  toTestFilePath,
} from '../planBatches'

const BASE = {
  workers: 4,
  mainFiles: ['src/server/__tests__/a.test.ts', 'src/client/__tests__/b.test.tsx'],
  serialFiles: REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`),
  passthrough: [],
  skipRealTmux: false,
}

describe('planBatches', () => {
  test('the main batch comes first, with --parallel', () => {
    const [main] = planBatches(BASE)
    expect(main.kind).toBe('parallel')
    expect(main.label).toBe('main batch')
    expect(main.cmd[0]).toBe('bun')
    expect(main.cmd[1]).toBe('test')
    expect(main.cmd).toContain('--parallel=4')
    expect(main.cmd.indexOf('--parallel=4')).toBeGreaterThan(-1)
    // Every non-tmux file rides the parallel batch.
    for (const file of BASE.mainFiles) {
      expect(main.cmd).toContain(`./${file}`)
    }
  })

  test('each real-tmux file is its own later batch, without --parallel or --coverage*', () => {
    const batches = planBatches({ ...BASE, passthrough: ['--coverage', '--coverage=lcov', '--coverage-reporter=text'] })
    const tmux = batches.filter((batch) => batch.kind === 'real-tmux')
    expect(tmux).toHaveLength(REAL_TMUX_FILES.length)
    // The main batch precedes every tmux batch.
    expect(batches.findIndex((batch) => batch.kind === 'parallel')).toBe(0)
    expect(batches.indexOf(tmux[0])).toBeGreaterThan(0)
    for (const [index, batch] of tmux.entries()) {
      expect(batch.label).toBe(`real-tmux: src/server/__tests__/${REAL_TMUX_FILES[index]}`)
      expect(batch.cmd.join(' ')).not.toContain('--coverage')
      // No --parallel of any spelling: the tmux batches are serial (N4).
      expect(batch.cmd.some((arg) => arg.startsWith('--parallel'))).toBe(false)
      expect(batch.cmd).toContain(`./src/server/__tests__/${REAL_TMUX_FILES[index]}`)
    }
  })

  test('--skip-real-tmux yields no tmux batch', () => {
    const batches = planBatches({ ...BASE, skipRealTmux: true })
    expect(batches).toHaveLength(1)
    expect(batches[0].kind).toBe('parallel')
  })

  test('an explicit integration.test.ts argument classifies as serial, by basename', () => {
    expect(isRealTmuxFile('integration.test.ts')).toBe(true)
    expect(isRealTmuxFile('src/server/__tests__/integration.test.ts')).toBe(true)
    expect(isRealTmuxFile('src/server/__tests__/indexHandlers.test.ts')).toBe(false)
    const batches = planBatches({
      ...BASE,
      mainFiles: ['src/server/__tests__/indexHandlers.test.ts'],
      serialFiles: ['src/server/__tests__/integration.test.ts'],
    })
    expect(batches).toHaveLength(2)
    expect(batches[1].kind).toBe('real-tmux')
    expect(batches[1].cmd).toContain('./src/server/__tests__/integration.test.ts')
    expect(batches[0].cmd).toContain('./src/server/__tests__/indexHandlers.test.ts')
  })

  test('an empty main batch contributes no batch; explicit runs label their main batch', () => {
    const onlySerial = planBatches({ ...BASE, mainFiles: [], mainLabel: 'explicit files' })
    expect(onlySerial.every((batch) => batch.kind === 'real-tmux')).toBe(true)
    const explicit = planBatches({ ...BASE, mainLabel: 'explicit files' })
    expect(explicit[0].label).toBe('explicit files')
  })

  test('the timings record rides the main batch only (3.1, D4)', () => {
    const withTimings = planBatches({ ...BASE, timingsPath: '/run/root/timings.json', updateTimings: true })
    expect(withTimings[0].cmd).toContain('--timings=/run/root/timings.json')
    expect(withTimings[0].cmd).toContain('--update-timings')
    for (const batch of withTimings.filter((candidate) => candidate.kind === 'real-tmux')) {
      expect(batch.cmd.some((arg) => arg.startsWith('--timings'))).toBe(false)
      expect(batch.cmd).not.toContain('--update-timings')
    }
    // No record, no flags: the default planning never mentions timings.
    for (const batch of planBatches(BASE)) {
      expect(batch.cmd.some((arg) => arg.startsWith('--timings'))).toBe(false)
      expect(batch.cmd).not.toContain('--update-timings')
    }
  })
})

describe('skipSlowTier', () => {
  // The real tree's test files, not a fixture: the tier selection must hold
  // for every file the runner could schedule (4.3, D7).
  async function realTestFiles(): Promise<string[]> {
    const files: string[] = []
    for (const pattern of [
      'src/server/__tests__/*.test.ts',
      'src/shared/__tests__/*.test.{ts,tsx}',
      'src/client/__tests__/*.test.{ts,tsx}',
      'scripts/__tests__/*.test.{ts,tsx}',
    ]) {
      const glob = new Bun.Glob(pattern)
      for await (const file of glob.scan({ onlyFiles: true })) files.push(file)
    }
    return files.sort()
  }

  test('excludes every *.integration.test.ts and real-tmux file of the real tree', async () => {
    const real = await realTestFiles()
    const tierFiles = real.filter(isSlowTierFile)
    // Sanity: this is the real tree — dozens of integration files exist.
    expect(tierFiles.length).toBeGreaterThan(25)
    const batches = planBatches({
      ...BASE,
      mainFiles: real,
      serialFiles: REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`),
      skipSlowTier: true,
    })
    expect(batches.some((batch) => batch.kind === 'real-tmux')).toBe(false)
    const scheduled = batches.flatMap((batch) => batch.cmd.filter((arg) => arg.startsWith('./')))
    for (const file of tierFiles) {
      expect(scheduled).not.toContain(toTestFilePath(file))
    }
    // The rest still runs.
    for (const file of excludeSlowTier(real)) {
      expect(scheduled).toContain(toTestFilePath(file))
    }
  })

  test('by default both tiers run: every tier file is scheduled', async () => {
    const real = await realTestFiles()
    const batches = planBatches({
      ...BASE,
      mainFiles: real,
      serialFiles: REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`),
    })
    const scheduled = batches.flatMap((batch) => batch.cmd.filter((arg) => arg.startsWith('./')))
    for (const file of real.filter(isIntegrationFile)) {
      expect(scheduled).toContain(toTestFilePath(file))
    }
    for (const file of REAL_TMUX_FILES) {
      expect(scheduled).toContain(toTestFilePath(`src/server/__tests__/${file}`))
    }
  })

  test('an empty main batch after exclusion yields no batch at all', () => {
    const onlyTier = planBatches({
      ...BASE,
      mainFiles: ['src/server/__tests__/integration.test.ts'],
      serialFiles: [],
      skipSlowTier: true,
    })
    expect(onlyTier).toEqual([])
  })

  test('the tier predicates classify by basename', () => {
    expect(isIntegrationFile('src/server/__tests__/teamTasks.integration.test.ts')).toBe(true)
    expect(isIntegrationFile('src/server/__tests__/teamTasks.test.ts')).toBe(false)
    expect(isSlowTierFile('integration.test.ts')).toBe(true)
    expect(isSlowTierFile('src/server/__tests__/copy-mode-async.integration.test.ts')).toBe(true)
    expect(isSlowTierFile('src/server/__tests__/indexHandlers.test.ts')).toBe(false)
  })
})

describe('junit report wiring (independent-verification D7, task 4.2)', () => {
  // @covers: dev-checks › Full-check records list the tests that ran › Interrupted writing
  test('every invocation gets its own unique report path (K3)', () => {
    const batches = planBatches({
      ...BASE,
      serialFiles: ['src/server/__tests__/integration.test.ts'],
      junitReportDir: '/run/reports',
    })
    const reportArgs = batches.map((batch) =>
      batch.cmd.filter((arg) => arg.startsWith('--reporter-outfile='))
    )
    // Every batch carries exactly the reporter pair.
    for (const args of reportArgs) {
      expect(args).toHaveLength(1)
    }
    const paths = reportArgs.map((args) => args[0]!.slice('--reporter-outfile='.length))
    expect(new Set(paths).size).toBe(paths.length)
    // All inside the asked-for directory, all .junit.xml.
    for (const reportPath of paths) {
      expect(reportPath.startsWith('/run/reports/')).toBe(true)
      expect(reportPath.endsWith('.junit.xml')).toBe(true)
    }
    // The parallel batch names its own kind, the serial batches theirs.
    expect(paths[0]).toContain('-parallel-')
    expect(paths[1]).toContain('-real-tmux-')
  })

  test('unset junitReportDir adds no reporter arguments', () => {
    for (const batch of planBatches(BASE)) {
      expect(batch.cmd.some((arg) => arg.startsWith('--reporter'))).toBe(false)
    }
  })

  test('a passthrough reporter wins: no second --reporter-outfile is appended', () => {
    // bun test takes the last --reporter-outfile; appending ours would move
    // a caller's report (a hook nested in a full check inherits the env).
    const batches = planBatches({
      ...BASE,
      serialFiles: ['src/server/__tests__/integration.test.ts'],
      passthrough: ['--reporter=junit', '--reporter-outfile=/hook/dir/changed.junit.xml'],
      junitReportDir: '/run/check-reports',
    })
    for (const batch of batches) {
      expect(batch.cmd.filter((arg) => arg.startsWith('--reporter-outfile='))).toEqual([
        '--reporter-outfile=/hook/dir/changed.junit.xml',
      ])
    }
  })
})
