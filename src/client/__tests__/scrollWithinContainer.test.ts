// Independent geometry oracles for bounded plan reveal, including borders
// and limits; production attention wiring is exercised by browser tests.
import { expect, test } from 'bun:test'
import { scrollWithinContainer } from '../utils/scrollWithinContainer'

const cases = [
  { name: 'below', offset: 600, height: 60, current: 100, expected: 580 },
  { name: 'above', offset: -150, height: 60, current: 500, expected: 230 },
  { name: 'already centered', offset: 120, height: 60, current: 100, expected: 100 },
  { name: 'tall target begins at pane top', offset: 600, height: 500, current: 100, expected: 700 },
  { name: 'top limit', offset: -150, height: 60, current: 0, expected: 0 },
  { name: 'bottom limit', offset: 3000, height: 60, current: 100, expected: 1700 },
  { name: 'title starts the pane', offset: 120, height: 30, current: 0, expected: 120, align: 'start' as const },
]
for (const row of cases) {
  test(`O3–O6/O8 geometry: ${row.name}`, () => {
    const writes: unknown[] = []
    const container = { clientHeight: 300, clientTop: 2, scrollHeight: 2000, scrollTop: row.current,
      getBoundingClientRect: () => ({ top: 100 }), scrollTo: (options: unknown) => writes.push(options) }
    const target = { isConnected: true, closest: (selector: string) => {
      expect(selector).toBe('[data-plan-scroll-container]'); return container
    }, getBoundingClientRect: () => ({ top: 102 + row.offset, height: row.height }),
    scrollIntoView: () => { throw new Error('unbounded scroll') } }
    scrollWithinContainer(target as unknown as HTMLElement, row.align)
    expect(writes).toEqual([{ top: row.expected, behavior: 'instant' }])
  })
}
test('O6 geometry: null, detached, absent boundary, and zero-height pane never scroll an ancestor', () => {
  const native: string[] = []
  scrollWithinContainer(null)
  for (const target of [
    { isConnected: false },
    { isConnected: true, closest: () => null },
    { isConnected: true, closest: () => ({ clientHeight: 0 }) },
  ]) scrollWithinContainer({ ...target, scrollIntoView: () => native.push('unbounded') } as unknown as HTMLElement)
  expect(native).toEqual([])
})
