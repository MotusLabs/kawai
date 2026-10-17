import { describe, expect, test } from 'bun:test'
import { CliTurnBinder, type CliContractViolation } from '../chat/cliTurnBinding'

function binder() {
  const violations: CliContractViolation[] = []
  const unknown: string[] = []
  const b = new CliTurnBinder({ violation: (reason) => violations.push(reason), unknownUuid: (uuid) => unknown.push(uuid) })
  return { b, violations, unknown }
}

/** A prompted driver turn the CLI has begun (its init arrived). */
function prompted(b: CliTurnBinder, turnId: string, ...uuids: string[]) {
  b.turnOpened(turnId, false)
  for (const uuid of uuids) b.promptSent(uuid, turnId)
  expect(b.init()).toBe('continue')
}

describe('CliTurnBinder', () => {
  test('a result ends the prompted turn its uuid names', () => {
    const { b, violations } = binder()
    prompted(b, 'turn-1', 'A')
    expect(b.result(['A'])).toBe('complete')
    expect(violations).toEqual([])
  })

  test('an agent-started turn ends on its uuid-less result', () => {
    const { b, violations } = binder()
    expect(b.init()).toBe('open')
    b.turnOpened('turn-1', true)
    expect(b.result([])).toBe('complete')
    expect(violations).toEqual([])
  })

  test('(i) a late or duplicate result naming a completed turn never closes the current one', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A')
    expect(b.result(['A'])).toBe('complete')
    prompted(b, 'turn-2', 'B')
    expect(b.result(['A'])).toBe('drop')
    expect(b.result(['B'])).toBe('complete')
    expect(b.result(['B'])).toBe('drop')
  })

  test('(ii) a never-sent uuid is logged and dropped, under a prompted or an agent-started turn', () => {
    const { b, unknown } = binder()
    prompted(b, 'turn-1', 'A')
    expect(b.result(['never-sent'])).toBe('drop')
    expect(b.result(['A'])).toBe('complete')
    expect(b.init()).toBe('open')
    b.turnOpened('turn-2', true)
    expect(b.result(['never-sent-2'])).toBe('drop')
    expect(b.result([])).toBe('complete')
    expect(unknown).toEqual(['never-sent', 'never-sent-2'])
  })

  test('a result naming a never-sent uuid beside a known one binds by the known one', () => {
    const { b, unknown } = binder()
    prompted(b, 'turn-1', 'A')
    expect(b.result(['internal', 'A'])).toBe('complete')
    expect(unknown).toEqual(['internal'])
  })

  test('(iv) one result with two uuids closes the one joined turn', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A', 'B')
    expect(b.result(['A', 'B'])).toBe('complete')
    // Nothing is carried: the next init is an agent-started turn's.
    expect(b.init()).toBe('open')
  })

  test('a joined prompt the CLI runs as its own turn ends the turn opened by its init', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A', 'B')
    expect(b.result(['A'], 1)).toBe('complete')
    expect(b.init()).toBe('open')
    b.turnOpened('turn-2', true)
    expect(b.result(['B'])).toBe('complete')
  })

  test('queued_turn_count 0 forgets carried prompts no result named', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A', 'B')
    expect(b.result(['A'], 0)).toBe('complete')
    b.turnOpened('turn-2', false)
    b.promptSent('C', 'turn-2')
    expect(b.init()).toBe('continue')
    // B was forgotten, so it no longer binds to turn-2.
    expect(b.result(['B'])).toBe('drop')
    expect(b.result(['C'])).toBe('complete')
  })

  test('an interrupted turn owes one result: its frames and result never reach the turn opened since', () => {
    const { b, violations } = binder()
    prompted(b, 'turn-1', 'A')
    b.turnInterrupted('turn-1')
    b.turnOpened('turn-2', false)
    b.promptSent('B', 'turn-2')
    expect(b.framesBelongToActive()).toBe(false)
    expect(b.result(['A'])).toBe('drop')
    expect(b.framesBelongToActive()).toBe(true)
    expect(b.init()).toBe('continue')
    expect(b.result(['B'])).toBe('complete')
    expect(violations).toEqual([])
  })

  test('an interrupted agent-started turn owes its uuid-less result', () => {
    const { b, violations } = binder()
    expect(b.init()).toBe('open')
    b.turnOpened('turn-1', true)
    b.turnInterrupted('turn-1')
    b.turnOpened('turn-2', false)
    b.promptSent('B', 'turn-2')
    expect(b.result([])).toBe('drop')
    expect(b.init()).toBe('continue')
    expect(b.result(['B'])).toBe('complete')
    expect(violations).toEqual([])
  })

  test('an interrupt landing before the turn\'s init absorbs that init', () => {
    const { b, violations } = binder()
    b.turnOpened('turn-1', false)
    b.promptSent('A', 'turn-1')
    b.turnInterrupted('turn-1')
    b.turnOpened('turn-2', false)
    b.promptSent('B', 'turn-2')
    expect(b.init()).toBe('absorbed')
    expect(b.result(['A'])).toBe('drop')
    expect(b.init()).toBe('continue')
    expect(b.result(['B'])).toBe('complete')
    expect(violations).toEqual([])
  })

  test('(iii) an init with a result still owed is out of contract: logged, and nothing strands', () => {
    const { b, violations } = binder()
    prompted(b, 'turn-1', 'A')
    b.turnInterrupted('turn-1')
    expect(b.init()).toBe('open')
    b.turnOpened('turn-2', true)
    expect(b.framesBelongToActive()).toBe(true)
    // The late tail names turn-1; the agent-started turn ends on its own.
    expect(b.result(['A'])).toBe('drop')
    expect(b.result([])).toBe('complete')
    expect(violations).toEqual(['init-before-owed-result'])
  })

  test('a later turn\'s result before the owed one is logged and still ends its turn', () => {
    const { b, violations } = binder()
    prompted(b, 'turn-1', 'A')
    b.turnInterrupted('turn-1')
    b.turnOpened('turn-2', false)
    b.promptSent('B', 'turn-2')
    expect(b.result(['B'])).toBe('complete')
    expect(violations).toEqual(['result-before-owed-result'])
    expect(b.framesBelongToActive()).toBe(true)
  })

  test('(e) a prompted result without a uuid ends the active turn and is logged', () => {
    const { b, violations } = binder()
    prompted(b, 'turn-1', 'A')
    expect(b.result([])).toBe('complete')
    expect(violations).toEqual(['prompted-result-without-uuid'])
  })

  test('(v) a joined send the interrupt cancelled before its init owes nothing', () => {
    const { b, violations } = binder()
    prompted(b, 'turn-1', 'A')
    expect(b.result(['A'])).toBe('complete')
    // turn-2's prompt is queued behind nothing yet: interrupted before init.
    b.turnOpened('turn-2', false)
    b.promptSent('B', 'turn-2')
    b.turnInterrupted('turn-2')
    expect(b.framesBelongToActive()).toBe(false)
    b.promptsWithdrawn(['B'])
    expect(b.framesBelongToActive()).toBe(true)
    expect(b.init()).toBe('open')
    expect(violations).toEqual([])
  })

  test('a running turn whose joined send was cancelled still owes its result', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A', 'B')
    b.turnInterrupted('turn-1')
    b.promptsWithdrawn(['B'])
    expect(b.framesBelongToActive()).toBe(false)
    expect(b.result(['A'])).toBe('drop')
    expect(b.framesBelongToActive()).toBe(true)
  })

  test('a turn whose prompts never reached the CLI owes nothing', () => {
    const { b } = binder()
    b.turnOpened('turn-1', false)
    b.promptSent('A', 'turn-1')
    b.promptsWithdrawn(['A'])
    b.turnInterrupted('turn-1')
    expect(b.framesBelongToActive()).toBe(true)
  })

  test('without cancel_queued a surviving joined send runs as a later turn', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A', 'B')
    b.turnInterrupted('turn-1')
    expect(b.result(['A'])).toBe('drop')
    expect(b.init()).toBe('open')
    b.turnOpened('turn-2', true)
    expect(b.result(['B'])).toBe('complete')
  })

  test('reset forgets owed results and outstanding prompts (process death)', () => {
    const { b } = binder()
    prompted(b, 'turn-1', 'A')
    b.turnInterrupted('turn-1')
    b.reset()
    expect(b.framesBelongToActive()).toBe(true)
    expect(b.init()).toBe('open')
  })

  test('remembers late uuids up to a bound, never evicting outstanding ones', () => {
    const { b, unknown } = binder()
    for (let i = 0; i < 600; i++) {
      prompted(b, `turn-${i}`, `u${i}`)
      expect(b.result([`u${i}`])).toBe('complete')
    }
    prompted(b, 'turn-x', 'live')
    for (let i = 0; i < 600; i++) b.promptSent(`extra${i}`, 'turn-x')
    expect(b.result(['u0'])).toBe('drop')
    expect(unknown).toEqual(['u0'])
    expect(b.result(['live'])).toBe('complete')
  })
})
