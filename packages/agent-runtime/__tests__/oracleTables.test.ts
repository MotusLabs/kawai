// Completeness of the committed oracle tables (task 1.3): the lifecycle table
// covers each of the 56 state/operation pairs exactly once (counting U01),
// and removing or overlapping a row is caught.
import { describe, expect, test } from 'bun:test'
import { LIFECYCLE_ROWS, OPERATIONS, STATES, completenessErrors, expandPairs, type LifecycleRow } from './oracles/lifecycleInputs.js'
import { POLICY_ROWS, policyIdErrors } from './oracles/policyInputs.js'

describe('lifecycle decision table', () => {
  test('expands to exactly the 56 state/operation pairs, each covered once', () => {
    expect(STATES.length * OPERATIONS.length).toBe(56)
    expect(expandPairs(LIFECYCLE_ROWS).size).toBe(56)
    expect(completenessErrors(LIFECYCLE_ROWS)).toEqual([])
  })

  test('row ids are unique and U01 is the only unreachable row', () => {
    const ids = LIFECYCLE_ROWS.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(LIFECYCLE_ROWS.filter((row) => row.unreachable).map((row) => row.id)).toEqual(['U01'])
  })

  test('control: removing any row leaves its pairs as gaps', () => {
    for (const removed of LIFECYCLE_ROWS) {
      const errors = completenessErrors(LIFECYCLE_ROWS.filter((row) => row !== removed)).sort()
      const pairs = removed.states.flatMap((state) => removed.operations.map((operation) => `gap: ${state}+${operation}`))
      expect(errors).toEqual(pairs.sort())
    }
  })

  test('control: an overlapping row is reported', () => {
    const overlap: LifecycleRow = { id: 'LX', states: ['idle'], operations: ['send', 'exit', 'native'] }
    expect(completenessErrors([...LIFECYCLE_ROWS, overlap])).toEqual([
      'overlap: idle+send (L07, LX)',
      'overlap: idle+exit (L14, LX)',
      'overlap: idle+native (L24, LX)',
    ])
  })
})

describe('policy table', () => {
  test('ids run P01-P16 without gaps or duplicates', () => {
    expect(POLICY_ROWS.length).toBe(16)
    expect(policyIdErrors(POLICY_ROWS)).toEqual([])
  })

  test('control: a dropped row is reported', () => {
    expect(policyIdErrors(POLICY_ROWS.filter((row) => row.id !== 'P07'))[0]).toBe('row 6: P08 where P07 belongs')
  })
})
