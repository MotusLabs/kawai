// The read-time outcome state (execution-safety-recovery D7): the terminal
// precedence denied > failed > completed, started-background under them,
// pending while the spawn lives, and outcome-unknown once it ends — never
// re-run, never re-judged.
import { describe, expect, test } from 'bun:test'
import { outcomeState } from '../outbound/outcomeState'

const rows = (...outcomes: string[]) => outcomes.map(outcome => ({ outcome }))

describe('outcomeState', () => {
  test('the precedence of every outcome', () => {
    expect(outcomeState({ outcomes: rows('completed'), spawnLive: true })).toBe('completed')
    expect(outcomeState({ outcomes: rows('failed', 'completed'), spawnLive: true })).toBe('failed')
    expect(outcomeState({ outcomes: rows('denied', 'failed', 'completed'), spawnLive: true })).toBe('denied')
    expect(outcomeState({ outcomes: rows('denied'), spawnLive: false })).toBe('denied')
    expect(outcomeState({ outcomes: rows('started-background'), spawnLive: true })).toBe('started-background')
    expect(outcomeState({ outcomes: rows('started-background', 'failed'), spawnLive: true })).toBe('failed')
  })

  test('pending while the spawn lives, outcome unknown once it ends', () => {
    expect(outcomeState({ outcomes: [], spawnLive: true })).toBe('pending')
    expect(outcomeState({ outcomes: [], spawnLive: false })).toBe('outcome-unknown')
    // A restart ends every live spawn: a settled-less call reads unknown.
    expect(outcomeState({ outcomes: rows('started-background'), spawnLive: false })).toBe('started-background')
  })
})
