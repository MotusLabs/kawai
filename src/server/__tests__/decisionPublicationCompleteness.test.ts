// @reads: openspec/changes/decision-bound-task-publication/design.md
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import { APPROVAL_ORACLES, BINDING_ORACLES, WORKFLOW_ORACLES } from './helpers/decisionPublicationOracles'

function tuples(axes: readonly (readonly string[])[]): string[][] {
  return axes.reduce<string[][]>((prefixes, axis) => prefixes.flatMap(prefix => axis.map(cell => [...prefix, cell])), [[]])
}

const cells = (line: string) => line.slice(2, -2).split(' | ')

function partition(table: Record<string, string>, axes: readonly (readonly string[])[], excluded: (input: string[]) => boolean) {
  const counts = Object.fromEntries(Object.keys(table).map(id => [id, 0]))
  let skipped = 0
  const inputs = tuples(axes)
  for (const input of inputs) {
    const matches = Object.values(table).map(cells).filter(([, ...row]) =>
      row.slice(0, input.length).every((cell, index) => cell === '*' || cell === input[index]))
    if (excluded(input)) {
      expect(matches).toEqual([])
      skipped++
    } else {
      expect([input, matches.map(row => row[0])]).toEqual([input, [expect.any(String)]])
      const id = matches[0]![0]!
      counts[id] = counts[id]! + 1
    }
  }
  return [inputs.length, ...Object.values(counts), skipped]
}

test('B00–B07 cover exactly 30 binding tuples with current authorization before replay', () => {
  expect(partition(BINDING_ORACLES,
    [['ordinary', 'invalid', 'not found', 'forbidden', 'allowed'], ['exact', 'different', 'absent'], ['unavailable', 'ready']],
    () => false)).toEqual([30, 6, 6, 6, 6, 2, 2, 1, 1, 0])
})

test('A01–A11 and U1 cover exactly 192 approval tuples without treating contradictory receipts as replay', () => {
  expect(partition(APPROVAL_ORACLES,
    [['invalid', 'forbidden', 'not found', 'allowed'], ['exact', 'different', 'inconsistent', 'unused'],
      ['plain', 'settled', 'open'], ['stale', 'current'], ['refused', 'successful']],
    ([access, prior, card]) => access === 'allowed' && prior === 'exact' && card !== 'settled'))
    .toEqual([192, 48, 48, 48, 12, 12, 4, 4, 4, 2, 1, 1, 8])
})

test('the executable B, A and W tables match the bound design verbatim and in order', () => {
  const artifact = fs.readFileSync('openspec/changes/decision-bound-task-publication/design.md', 'utf8')
  expect(artifact.split('\n').filter(row => /^\| (B0[0-7]|A\d\d|W\d\d) \|/.test(row))).toEqual([
    ...Object.values(BINDING_ORACLES), ...Object.values(APPROVAL_ORACLES), ...Object.values(WORKFLOW_ORACLES),
  ])
})
