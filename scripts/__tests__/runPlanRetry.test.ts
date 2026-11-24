// runPlanRetry.test.ts - The retry decision table RT1–RT6 of
// check-time-optimization design.md (D2, task 3.1), verbatim, over
// runBatchesAndPublish with an injected runCommand: which files rerun, the
// step result (a throw fails the unit step), and the retries the record
// would carry. A signal-refused batch is never collected as a failure.
import { describe, expect, test } from 'bun:test'
import type { PlannedBatch } from '../planBatches'
import { BatchRefusedError, runBatchesAndPublish, type BatchRunOutcome } from '../runPlan'

const TMUX = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `src/server/__tests__/${name}.integration.test.ts`)

function main(): PlannedBatch {
  return { kind: 'parallel', label: 'main batch', cmd: ['bun', 'test', 'main'] }
}

function tmux(file: string): PlannedBatch {
  return { kind: 'real-tmux', label: `real-tmux: ${file}`, cmd: ['bun', 'test', file], file }
}

interface Row {
  id: string
  main: 'pass' | 'fail'
  /** Real-tmux files that fail their first attempt. */
  failing: string[]
  retries: boolean
  /** Files whose rerun fails as well. */
  rerunFails: string[]
  /** Expected: the reruns, in order. */
  reruns: string[]
  step: 'pass' | 'fail'
  /** Expected record `retries` on a pass. */
  recorded?: BatchRunOutcome['retries']
  /** Expected substrings of the failure message. */
  message?: string[]
}

const failuresOf = (file: string, attempt: 'first' | 'rerun') => [`${file} › ${attempt} case`]

const ROWS: Row[] = [
  // RT1: main fails → no real-tmux file runs, nothing reruns, step fails.
  { id: 'RT1', main: 'fail', failing: [TMUX[0]!], retries: true, rerunFails: [], reruns: [], step: 'fail', message: ['main failed'] },
  { id: 'RT1', main: 'fail', failing: [], retries: false, rerunFails: [], reruns: [], step: 'fail', message: ['main failed'] },
  // RT2: F = 0 → no rerun, pass, no retries.
  { id: 'RT2', main: 'pass', failing: [], retries: true, rerunFails: [], reruns: [], step: 'pass', recorded: [] },
  { id: 'RT2', main: 'pass', failing: [], retries: false, rerunFails: [], reruns: [], step: 'pass', recorded: [] },
  // RT3: F = 1–2, retries on, every rerun passes → each failed file reruns
  // once after all real-tmux files; pass; the record names each with its
  // first-attempt failures.
  {
    id: 'RT3', main: 'pass', failing: [TMUX[2]!], retries: true, rerunFails: [], reruns: [TMUX[2]!], step: 'pass',
    recorded: [{ file: TMUX[2]!, failures: failuresOf(TMUX[2]!, 'first') }],
  },
  {
    id: 'RT3', main: 'pass', failing: [TMUX[0]!, TMUX[6]!], retries: true, rerunFails: [], reruns: [TMUX[0]!, TMUX[6]!], step: 'pass',
    recorded: [
      { file: TMUX[0]!, failures: failuresOf(TMUX[0]!, 'first') },
      { file: TMUX[6]!, failures: failuresOf(TMUX[6]!, 'first') },
    ],
  },
  // RT4: F = 1–2, retries on, a rerun fails → each failed file reruns once;
  // fail, naming the file and both attempts.
  {
    id: 'RT4', main: 'pass', failing: [TMUX[1]!], retries: true, rerunFails: [TMUX[1]!], reruns: [TMUX[1]!], step: 'fail',
    message: [TMUX[1]!, `${TMUX[1]!} › first case`, `${TMUX[1]!} › rerun case`],
  },
  {
    id: 'RT4', main: 'pass', failing: [TMUX[1]!, TMUX[3]!], retries: true, rerunFails: [TMUX[3]!], reruns: [TMUX[1]!, TMUX[3]!], step: 'fail',
    message: [TMUX[3]!, `${TMUX[3]!} › first case`, `${TMUX[3]!} › rerun case`],
  },
  // RT5: F ≥ 3, either retry setting → no rerun, fail.
  { id: 'RT5', main: 'pass', failing: TMUX.slice(0, 3), retries: true, rerunFails: [], reruns: [], step: 'fail', message: ['3 real-tmux files failed'] },
  { id: 'RT5', main: 'pass', failing: TMUX, retries: true, rerunFails: [], reruns: [], step: 'fail', message: ['7 real-tmux files failed'] },
  { id: 'RT5', main: 'pass', failing: TMUX.slice(0, 3), retries: false, rerunFails: [], reruns: [], step: 'fail', message: [TMUX[2]!] },
  // RT6: F = 1–2, retries off → no rerun, fail.
  { id: 'RT6', main: 'pass', failing: [TMUX[4]!], retries: false, rerunFails: [], reruns: [], step: 'fail', message: ['retries off', TMUX[4]!] },
  { id: 'RT6', main: 'pass', failing: [TMUX[4]!, TMUX[5]!], retries: false, rerunFails: [], reruns: [], step: 'fail', message: ['retries off', TMUX[5]!] },
]

async function runRow(row: Row) {
  const ran: string[] = []
  const reruns: string[] = []
  const rerunFailing = new Set(row.rerunFails)
  const failing = new Set(row.failing)
  let outcome: BatchRunOutcome | undefined
  let thrown: Error | undefined
  try {
    outcome = await runBatchesAndPublish({
      batches: [main(), ...TMUX.map(tmux)],
      env: {},
      publishTimingsPath: null,
      publish: () => {},
      runCommand: async (_cmd, _env, label) => {
        ran.push(label)
        if (label === 'main batch') {
          if (row.main === 'fail') throw new Error('main failed')
          return
        }
        const rerun = label.startsWith('real-tmux rerun: ')
        const file = label.replace(/^real-tmux( rerun)?: /, '')
        if (rerun) {
          reruns.push(file)
          if (rerunFailing.has(file)) throw new Error(`Command failed (1): ${file}`)
          return
        }
        if (failing.has(file)) throw new Error(`Command failed (1): ${file}`)
      },
      retry: {
        enabled: row.retries,
        planRerun: (batch) => ({ ...batch, label: `real-tmux rerun: ${batch.file}`, report: 'rerun' }),
        failingTests: (batch) => failuresOf(batch.file!, batch.report === 'rerun' ? 'rerun' : 'first'),
      },
    })
  } catch (error) {
    thrown = error as Error
  }
  return { ran, reruns, outcome, thrown }
}

describe('real-tmux retry decision table (check-time-optimization D2)', () => {
  // One literal call per table row, unrolled from the template loop by the
  // check-time-optimization closeout (task 7.1); each title is the row's
  // rendered text, and the assertions are the loop's unchanged. Each row
  // carries the scenario annotation its outcome exercises.
  const expectRow = async (row: Row) => {
    const { ran, reruns, outcome, thrown } = await runRow(row)
    expect(reruns).toEqual(row.reruns)
    if (row.main === 'fail') {
      // No real-tmux file runs after a main-batch failure.
      expect(ran).toEqual(['main batch'])
    } else {
      // Every real-tmux file ran its first attempt, and every rerun came
      // after the last of them.
      const firsts = ran.filter((label) => label.startsWith('real-tmux: '))
      expect(firsts).toEqual(TMUX.map((file) => `real-tmux: ${file}`))
      const lastFirst = ran.lastIndexOf(`real-tmux: ${TMUX[TMUX.length - 1]}`)
      ran.forEach((label, index) => {
        if (label.startsWith('real-tmux rerun: ')) expect(index).toBeGreaterThan(lastFirst)
      })
    }
    if (row.step === 'pass') {
      expect(thrown).toBeUndefined()
      expect(outcome?.retries).toEqual(row.recorded!)
    } else {
      expect(thrown).toBeInstanceOf(Error)
      for (const part of row.message ?? []) expect(thrown!.message).toContain(part)
    }
  }

  // @covers: dev-checks › A failed real-tmux file is retried once › A main-batch failure
  test('RT1: main fail, F=1, retries on, reruns pass → fail', async () => {
    await expectRow(ROWS[0]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › A main-batch failure
  test('RT1: main fail, F=0, retries off, reruns pass → fail', async () => {
    await expectRow(ROWS[1]!)
  })

  test('RT2: main pass, F=0, retries on, reruns pass → pass', async () => {
    await expectRow(ROWS[2]!)
  })

  test('RT2: main pass, F=0, retries off, reruns pass → pass', async () => {
    await expectRow(ROWS[3]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › One timing failure
  test('RT3: main pass, F=1, retries on, reruns pass → pass', async () => {
    await expectRow(ROWS[4]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › One timing failure
  test('RT3: main pass, F=2, retries on, reruns pass → pass', async () => {
    await expectRow(ROWS[5]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › The rerun fails too
  test('RT4: main pass, F=1, retries on, a rerun fails → fail', async () => {
    await expectRow(ROWS[6]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › The rerun fails too
  test('RT4: main pass, F=2, retries on, a rerun fails → fail', async () => {
    await expectRow(ROWS[7]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › Three real-tmux files fail
  test('RT5: main pass, F=3, retries on, reruns pass → fail', async () => {
    await expectRow(ROWS[8]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › Three real-tmux files fail
  test('RT5: main pass, F=7, retries on, reruns pass → fail', async () => {
    await expectRow(ROWS[9]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › Three real-tmux files fail
  test('RT5: main pass, F=3, retries off, reruns pass → fail', async () => {
    await expectRow(ROWS[10]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › Retries turned off
  test('RT6: main pass, F=1, retries off, reruns pass → fail', async () => {
    await expectRow(ROWS[11]!)
  })

  // @covers: dev-checks › A failed real-tmux file is retried once › Retries turned off
  test('RT6: main pass, F=2, retries off, reruns pass → fail', async () => {
    await expectRow(ROWS[12]!)
  })

  test('a signal-refused real-tmux batch propagates instead of being collected', async () => {
    let thrown: unknown
    const ran: string[] = []
    try {
      await runBatchesAndPublish({
        batches: [main(), tmux(TMUX[0]!), tmux(TMUX[1]!)],
        env: {},
        publishTimingsPath: null,
        publish: () => {},
        runCommand: async (_cmd, _env, label) => {
          ran.push(label)
          if (label !== 'main batch') throw new BatchRefusedError(`Signal handled; not starting batch: ${label}`)
        },
        retry: { enabled: true, planRerun: (batch) => batch, failingTests: () => [] },
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(BatchRefusedError)
    expect(ran).toEqual(['main batch', `real-tmux: ${TMUX[0]}`])
  })
})
