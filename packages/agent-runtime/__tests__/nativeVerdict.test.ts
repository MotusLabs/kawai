// The native verdict and account (task 4.1 A3, R4 bindings B1/B3/B4) as a
// decision table over frozen evidence. The mark is intent, not cause. Only an
// exit 0, or a marked owner's own successful signal, is not a failure. A
// nonzero exit, a trapped exit (143 included), an unsent or unmarked signal,
// a spawn failure and missing evidence all fail. Every child error and
// recorder failure is kept by identity whatever the verdict, as is a spawn
// failure's original error, and a failed generation nests only its own
// stored projections.
import { describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '../src/errors.js'
import { NativeExitFailure, nativeCauses, nativeVerdict, type NativeVerdict } from '../src/process/nativeVerdict.js'
import type { LeaderExit, NativeEvidence, OwnedProcess } from '../src/process/ownedProcess.js'

const exited = (code: number | null, signal: NodeJS.Signals | null): LeaderExit => ({ kind: 'exited', code, signal })
const evidence = (exit: LeaderExit, marked: boolean, sentAfterMark: NodeJS.Signals[] = [], errors: Error[] = []): NativeEvidence => ({ exit, marked, sentAfterMark, errors })

describe('nativeVerdict decision table', () => {
  const rows: Array<[string, NativeEvidence | null, NativeVerdict]> = [
    ['exit 0, unmarked', evidence(exited(0, null), false), 'clean'],
    ['exit 0, marked', evidence(exited(0, null), true, ['SIGTERM']), 'clean'],
    ['marked, own SIGTERM sent, died of SIGTERM', evidence(exited(null, 'SIGTERM'), true, ['SIGTERM']), 'owned'],
    ['marked, own SIGTERM then SIGKILL, died of SIGKILL', evidence(exited(null, 'SIGKILL'), true, ['SIGTERM', 'SIGKILL']), 'owned'],
    ['exit 3 before the mark', evidence(exited(3, null), false), 'failed'],
    ['exit 3 after the mark (a trap)', evidence(exited(3, null), true, ['SIGTERM']), 'failed'],
    ['exit 143 after the mark (a trap re-raising by code)', evidence(exited(143, null), true, ['SIGTERM']), 'failed'],
    ['SIGTERM, unmarked', evidence(exited(null, 'SIGTERM'), false), 'failed'],
    ['SIGTERM after the mark, but this owner never sent it', evidence(exited(null, 'SIGTERM'), true, []), 'failed'],
    ['SIGKILL after the mark, only SIGTERM sent', evidence(exited(null, 'SIGKILL'), true, ['SIGTERM']), 'failed'],
    ['an unknown signal after the mark', evidence(exited(null, 'SIGSEGV'), true, ['SIGTERM']), 'failed'],
    ['spawn failed', evidence({ kind: 'spawn-failed', error: new Error('ENOENT') }, true), 'failed'],
    ['no evidence', null, 'failed'],
  ]
  for (const [name, input, verdict] of rows) {
    test(`${name}: ${verdict}`, () => {
      expect(nativeVerdict(input)).toBe(verdict)
    })
  }
})

function owner(input: NativeEvidence | null, observerFailures: unknown[] = [], pid: number | null = 4242): OwnedProcess {
  return { pid, evidence: input, observerFailures } as unknown as OwnedProcess
}

describe('nativeCauses account', () => {
  test('a failed generation adds one NativeExitFailure nesting only its projections, beside every kept error', () => {
    const childError = new Error('pipe broke while the leader lived')
    const recorderError = new Error('recorder threw')
    const projection = new Error('stop-token AbortError')
    const causes = nativeCauses(2, owner(evidence(exited(3, null), false, [], [childError]), [recorderError]), [projection])
    expect(causes).toHaveLength(3)
    const failure = causes[0] as NativeExitFailure
    expect(failure).toBeInstanceOf(NativeExitFailure)
    expect(failure).toBeInstanceOf(AgentRuntimeError)
    expect([failure.category, failure.message]).toEqual(['transport', 'agent process generation 2 exited with code 3 before the stop'])
    expect(failure.facts).toEqual({ generation: 2, pid: 4242, code: 3, signal: null, observedBeforeStop: true })
    expect(failure.causes).toHaveLength(1)
    expect(failure.causes[0]).toBe(projection)
    expect(causes[1]).toBe(childError)
    expect(causes[2]).toBe(recorderError)
  })

  test('a trapped exit after the mark is a failure observed after the stop began', () => {
    const [failure] = nativeCauses(1, owner(evidence(exited(3, null), true, ['SIGTERM'])), []) as [NativeExitFailure]
    expect(failure.facts).toEqual({ generation: 1, pid: 4242, code: 3, signal: null, observedBeforeStop: false })
    expect(failure.message).toBe('agent process generation 1 exited with code 3 after the stop began')
  })

  test('a clean or owned end adds no failure, yet still keeps child errors and recorder failures', () => {
    const childError = new Error('child error')
    const recorderError = new Error('recorder threw')
    const projection = new Error('stop-token AbortError')
    for (const input of [evidence(exited(0, null), false, [], [childError]), evidence(exited(null, 'SIGTERM'), true, ['SIGTERM'], [childError])]) {
      const causes = nativeCauses(1, owner(input, [recorderError]), [projection])
      expect(causes).toHaveLength(2)
      expect(causes[0]).toBe(childError)
      expect(causes[1]).toBe(recorderError)
    }
  })

  test('missing evidence is a failure with no exit facts', () => {
    const [failure] = nativeCauses(4, owner(null, [], null), []) as [NativeExitFailure]
    expect(failure.facts).toEqual({ generation: 4, pid: null, code: null, signal: null, observedBeforeStop: null })
    expect(failure.message).toBe('agent process generation 4 left no exit evidence')
  })

  test('a spawn failure adds no NativeExitFailure: its original error, kept errors and projections pass through by identity', () => {
    const spawnError = new Error('spawn ENOENT')
    const projection = new Error('stop-token AbortError')
    const recorderError = new Error('recorder threw')
    const causes = nativeCauses(1, owner(evidence({ kind: 'spawn-failed', error: spawnError }, false), [recorderError], null), [projection])
    expect(causes).toHaveLength(3)
    expect(causes[0]).toBe(spawnError)
    expect(causes[1]).toBe(recorderError)
    expect(causes[2]).toBe(projection)
    expect(causes.some((c) => c instanceof NativeExitFailure)).toBe(false)
  })
})
