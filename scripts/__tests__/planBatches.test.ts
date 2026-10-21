import { describe, expect, test } from 'bun:test'
import { REAL_TMUX_FILES, isRealTmuxFile, planBatches } from '../planBatches'

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
      expect(batch.cmd).not.toContain('--parallel=4')
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
})
