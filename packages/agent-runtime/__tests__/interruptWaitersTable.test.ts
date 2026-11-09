// Completeness of the interrupt-versus-waiting-sends table (task 4.4 Claude
// checkpoint unit, R3 A4): the waiter rows cover each of the 28 state/kind
// pairs exactly once, the receipt rows each state once per waiter presence,
// and removing or overlapping a row is caught; the supplement adds the
// admission wait reason and conditional traces. Inputs only: no outputs yet.
import { describe, expect, test } from 'bun:test'
import {
  AFTER_INTERRUPT_ROWS,
  WAITER_KINDS,
  WAITER_RECEIPT_ROWS,
  WAITER_ROWS,
  WAITER_STATES,
  expandWaiterPairs,
  receiptCompletenessErrors,
  waiterCompletenessErrors,
  type WaiterRow,
} from './oracles/interruptWaitersInputs.js'
import { ADMISSION_ROWS, CONDITIONAL_ROWS, admissionCompletenessErrors } from './oracles/interruptWaitersSupplement.js'

describe('interrupt versus waiting sends: inputs table', () => {
  test('expands to exactly the 28 state/kind pairs, each covered once', () => {
    expect(WAITER_STATES.length * WAITER_KINDS.length).toBe(28)
    expect(expandWaiterPairs(WAITER_ROWS).size).toBe(28)
    expect(waiterCompletenessErrors(WAITER_ROWS)).toEqual([])
  })

  test('row ids are unique, U11 is the only unreachable row, and every reachable row says how it arises', () => {
    const ids = [...WAITER_ROWS, ...WAITER_RECEIPT_ROWS, ...AFTER_INTERRUPT_ROWS].map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(WAITER_ROWS.filter((row) => row.unreachable).map((row) => row.id)).toEqual(['U11'])
    for (const row of WAITER_ROWS) if (!row.unreachable) expect(row.arises.length).toBeGreaterThan(10)
  })

  test('receipt rows cover each state once with and without waiters', () => {
    expect(receiptCompletenessErrors(WAITER_RECEIPT_ROWS)).toEqual([])
  })

  test('control: removing any waiter row leaves its pairs as gaps', () => {
    for (const removed of WAITER_ROWS) {
      const errors = waiterCompletenessErrors(WAITER_ROWS.filter((row) => row !== removed)).sort()
      const pairs = removed.states.flatMap((state) => removed.kinds.map((kind) => `gap: ${state}+${kind}`))
      expect(errors).toEqual(pairs.sort())
    }
  })

  test('control: an overlapping waiter row and a dropped receipt row are reported', () => {
    const overlap: WaiterRow = { id: 'WX', states: ['idle'], kinds: ['none', 'persistence-queue'], arises: 'control row for the test' }
    expect(waiterCompletenessErrors([...WAITER_ROWS, overlap])).toEqual(['overlap: idle+none (W01, WX)', 'overlap: idle+persistence-queue (W08, WX)'])
    expect(receiptCompletenessErrors(WAITER_RECEIPT_ROWS.filter((row) => row.id !== 'WR2'))).toEqual([
      'gap: unstarted+at least one',
      'gap: idle+at least one',
      'gap: exited+at least one',
    ])
  })
})

describe('interrupt versus waiting sends: inputs supplement', () => {
  test('the admission wait reason covers each state once', () => {
    expect(admissionCompletenessErrors(ADMISSION_ROWS)).toEqual([])
  })

  test('supplement ids are unique and disjoint from the first table', () => {
    const ids = [...ADMISSION_ROWS, ...CONDITIONAL_ROWS].map((row) => row.id)
    const first = new Set([...WAITER_ROWS, ...WAITER_RECEIPT_ROWS, ...AFTER_INTERRUPT_ROWS].map((row) => row.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => first.has(id))).toEqual([])
  })

  test('control: a dropped admission row is reported', () => {
    expect(admissionCompletenessErrors(ADMISSION_ROWS.filter((row) => row.id !== 'X03'))).toEqual(['gap: exited+admission'])
  })
})
