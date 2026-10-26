// The workspace's passive health dots (plan-workspace 5.4, design D5): the
// shared derivation's display states rendered from the snapshot's readings —
// green needs fresh context AND an applicable quota, partial telemetry reads
// unknown, staleness and a passed reset read unknown, a disconnected
// workspace reads unknown regardless of age, and excluded readings stay
// inspectable in the disclosure.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkspaceAgentReading } from '@shared/planWorkspace'
import PlanWorkspaceHealth, { WorkspaceHealthDot } from '../components/team/PlanWorkspaceHealth'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const NOW = new Date('2026-10-23T12:00:00.000Z')
const fresh = '2026-10-23T11:55:00.000Z'

const reading = (extra: Partial<WorkspaceAgentReading> = {}): WorkspaceAgentReading => ({
  sessionId: 's1', name: 'Dev', relevance: 'holder',
  context: { used: 0.5, measuredAt: fresh },
  quota: { status: 'ok', used: 0.4, resetsAt: '2026-10-24T00:00:00.000Z', measuredAt: fresh, source: 'provider' },
  quotaApplicable: true,
  ...extra,
})

const dot = (reading: WorkspaceAgentReading, connected = true) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WorkspaceHealthDot reading={reading} connected={connected} now={NOW} />) })
  renderers.push(renderer)
  return {
    level: () => renderer.root.findByProps({ 'data-testid': 'workspace-health-dot-s1' }).props['data-level'],
    label: () => renderer.root.findByProps({ 'data-testid': 'workspace-health-s1' }).findByType('summary').props['aria-label'] as string,
    detail: () => textOf(renderer.root.findByProps({ 'data-testid': 'workspace-health-detail-s1' })),
    renderer,
  }
}

test('fresh green context with a fresh applicable ok quota reads green', () => {
  const view = dot(reading())
  expect(view.level()).toBe('green')
  expect(view.label()).toContain('Health healthy')
  expect(view.label()).toContain('context green (50%)')
})

test('partial telemetry — a missing quota — reads unknown, not green', () => {
  const view = dot(reading({ quota: null }))
  expect(view.level()).toBe('unknown')
  expect(view.label()).toContain('quota unknown (no reading)')
})

test('a stale reading reads unknown at the same wall clock', () => {
  const view = dot(reading({ context: { used: 0.5, measuredAt: '2026-10-23T09:00:00.000Z' } }))
  expect(view.level()).toBe('unknown')
  expect(view.detail()).toContain('measured')
})

test('a quota whose reset passed reads unknown; limited reads red; account source is excluded', () => {
  const resetPassed = dot(reading({ quota: { status: 'ok', used: 0.4, resetsAt: '2026-10-22T00:00:00.000Z', measuredAt: fresh, source: 'profile' } }))
  expect(resetPassed.level()).toBe('unknown')
  const limited = dot(reading({ quota: { status: 'limited', used: 1, resetsAt: null, measuredAt: fresh, source: 'provider' } }))
  expect(limited.level()).toBe('red')
  // An account allowance behind a gateway provider stays visible but contributes unknown.
  const excluded = dot(reading({ quota: { status: 'ok', used: 0.4, resetsAt: null, measuredAt: fresh, source: 'account' }, quotaApplicable: false }))
  expect(excluded.level()).toBe('unknown')
  expect(excluded.detail()).toContain('the host account')
  expect(excluded.detail()).toContain('excluded from the combined indicator')
})

test('a disconnected workspace reads unknown regardless of age and says so', () => {
  const view = dot(reading(), false)
  expect(view.level()).toBe('unknown')
  expect(view.detail()).toContain('Disconnected')
})

test('the list shows every exposed agent and an empty roster names its emptiness', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<PlanWorkspaceHealth readings={[reading(), reading({ sessionId: 's2', name: null, relevance: 'architect' })]} connected />) })
  renderers.push(renderer)
  expect(renderer.root.findAllByProps({ 'data-testid': 'workspace-health-s1' }).length).toBe(1)
  expect(renderer.root.findAllByProps({ 'data-testid': 'workspace-health-s2' }).length).toBe(1)
  act(() => { renderer.update(<PlanWorkspaceHealth readings={[]} connected />) })
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'workspace-health-empty' }))).toContain('No assigned agents')
})
