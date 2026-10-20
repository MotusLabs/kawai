// The Plans view's usage section (plan-supervision D14, D15, §10.4): totals
// and per-group × profile rows, one row per change plus one per fix task,
// the notes stating what is not counted — and no currency anywhere: tokens
// and turns only. The view comes from the real `planUsage` aggregation over
// fixture turns, as the server would produce it.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { planUsage, type PlanUsageTurn } from '@shared/planUsage'
import PlanUsageSection from '../components/team/PlanUsageSection'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const turn = (over: Partial<PlanUsageTurn>): PlanUsageTurn => ({
  taskId: 'task-1', groupId: 'middle-devs', profileId: 'glm',
  usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheCreationTokens: 50 },
  numTurns: 3, change: 'api', fix: null, ...over,
})

const mount = (usage: ReturnType<typeof planUsage>) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<PlanUsageSection view={usage} />,
      { createNodeMock: _node => ({ focus: () => {} }) })
  })
  renderers.push(renderer)
  return { text: () => textOf(renderer.root), root: renderer.root }
}

test('usage totals, group × profile rows, and per-change and fix-task rows render', () => {
  const usage = planUsage([
    turn({ taskId: 'task-1', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheCreationTokens: 50 }, numTurns: 3 }),
    turn({ taskId: 'task-1', usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 }, numTurns: 2 }),
    turn({ taskId: 'task-2', change: 'ui', groupId: 'senior-devs', profileId: 'opus',
      usage: { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 9000, cacheCreationTokens: 700 }, numTurns: 5 }),
    turn({ taskId: 'task-fix-1', change: null, fix: { sourceKind: 'override' },
      usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 0 }, numTurns: 1 }),
  ], ['api', 'ui'])
  const ui = mount(usage)
  expect(ui.text()).toContain('All roles and profiles: 4 turns · 11 steps · in 3,800 · out 1,140 · cache read 9,410 · cache write 750')
  expect(ui.text()).toContain('middle-devs · glm')
  expect(ui.text()).toContain('senior-devs · opus')
  expect(ui.text()).toContain('2 turns · 5 steps · in 1,500 · out 300 · cache read 400 · cache write 50')
  expect(ui.text()).toContain('api —')
  expect(ui.text()).toContain('ui —')
  expect(ui.text()).toContain('Forward override task task-fix-1… — 1 turn · 1 steps · in 300 · out 40 · cache read 10 · cache write 0')
})

test('the notes state what is not counted and no currency appears anywhere', () => {
  const usage = planUsage([turn({ change: null })], ['api'])
  const ui = mount(usage)
  const notes = ui.root.findByProps({ 'data-testid': 'plan-usage-notes' })
  const noteText = notes.children.map(textOf).join('')
  expect(noteText).toContain('Turns with no task are not attributed to any plan.')
  expect(noteText).toContain('Task subagent and auxiliary calls are not counted')
  expect(ui.text()).toContain('(task without a change)')
  // Tokens and turns only — no currency sign and no spelled-out money unit.
  expect(ui.text().includes('$')).toBe(false)
  expect(ui.text().toLowerCase()).not.toContain('usd')
  expect(ui.text().toLowerCase()).not.toContain('cost')
})

test('empty usage reads as no recorded turns yet in both breakdowns', () => {
  const ui = mount(planUsage([], []))
  expect(ui.text().split('No recorded turns yet.').length - 1).toBe(2)
})
