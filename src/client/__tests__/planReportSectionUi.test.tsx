// The Plans view's supervision report (plan-supervision D12, D15, §10.3):
// a stopped plan shows the stop's reason label, the last round's evidence,
// its blocked dependents, and Retry or stop execution beside partial
// delivery ("Landed N of M", success criteria listed but never claimed); a
// stalled plan shows the stall kind with progress apart from activity; a
// fully landed plan reads "All M changes landed" with the override count,
// fix durations, and a non-continue strategy disposition linked to its
// review. The section mounts in the plan detail only when the detail
// carries it.
import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import type { PlanDetail } from '@shared/plans'
import { normalizePlanContent, type PlanContent } from '@shared/plans'
import type { ChangeSupervision } from '@shared/planSupervision'
import type { PlanSupervisionView } from '@shared/planReport'
import type { CiCheck } from '@shared/planExecution'
import { planReport, STOP_NEXT_ACTION } from '@shared/planReport'
import PlanReportSection from '../components/team/PlanReportSection'
import TeamPlansView from '../components/team/TeamPlansView'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { planSummary } from './planViewFixtures'

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers) act(() => renderer.unmount())
  renderers.length = 0
  useTeamPlanStore.setState({ views: {} })
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')

const SESSIONS = [{ id: 'dev-1', name: 'Dev One' }] as unknown as Session[]
const CONTENT = normalizePlanContent({
  goal: 'Ship', successCriteria: ['Every check green on master'],
  changes: [{ change: 'api' }, { change: 'ui', dependsOn: ['api'] }, { change: 'docs', dependsOn: ['ui'] }],
}) as PlanContent

const check = (name: string, conclusion: CiCheck['conclusion']): CiCheck =>
  ({ name, source: 'actions', conclusion, link: null, startedAt: null, completedAt: null })

const row = (over: Partial<ChangeSupervision> & { change: string }): ChangeSupervision => ({
  outcome: 'running', cause: { kind: 'stage', stage: 'implement', step: 'awaiting-ci' }, alsoApplying: [], stage: 'implement',
  holder: null, progress: null, activity: null, stall: null, landing: null, lastRound: null, ...over,
})

const view = (rows: ChangeSupervision[], decisions: Parameters<typeof planReport>[0]['decisions'] = []): PlanSupervisionView => ({
  changes: rows,
  report: planReport({ supervision: rows, content: CONTENT, decisions, candidates: [], impact: null }),
  computedAt: '2026-10-14T00:00:00.000Z',
})

const section = (supervision: PlanSupervisionView, onOpenImpactReview?: (revision: number) => void) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <PlanReportSection view={supervision} sessions={SESSIONS} onOpenImpactReview={onOpenImpactReview} />,
      { createNodeMock: _node => ({ focus: () => {} }) },
    )
  })
  renderers.push(renderer)
  return { renderer, text: () => textOf(renderer.root) }
}

test('a stopped plan shows the reason label, evidence, blocked dependents, and partial delivery', () => {
  const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  const supervision = view([
    row({
      change: 'api', outcome: 'stopped', cause: { kind: 'stopped', reason: 'round-limit', detail: { message: 'Three fix rounds failed.' } },
      lastRound: {
        id: 'r3', number: 3, outcome: 'fail', failing: [check('ci / unit-tests', 'fail')], flaky: ['lint'],
        verdict: 'fail', findingsSummary: '2 findings, worst first',
      },
      progress: { kind: 'result', at: hoursAgo }, activity: { kind: 'turn', at: hoursAgo },
    }),
    row({ change: 'ui', outcome: 'waiting', cause: { kind: 'dependency', changes: ['api'], stopped: ['api'] } }),
    row({ change: 'docs', outcome: 'landed', cause: { kind: 'landed', treeVerified: true },
      landing: { landedAt: hoursAgo, treeVerified: true, mergeSha: 'm3', postCi: null } }),
  ])
  const ui = section(supervision)
  expect(ui.text()).toContain('Landed 1 of 3')
  expect(ui.text()).toContain('Landed 1 · Waiting 1 · Stopped 1')
  expect(ui.text()).toContain('Blocked by api')
  expect(ui.text()).toContain('api — stopped: Failed 3 fix rounds')
  expect(ui.text()).toContain('Three fix rounds failed.')
  expect(ui.text()).toContain('failing: ci / unit-tests')
  expect(ui.text()).toContain('flaky: lint')
  expect(ui.text()).toContain('review fail')
  expect(ui.text()).toContain('2 findings, worst first')
  expect(ui.text()).toContain('Blocked dependents: ui')
  expect(ui.text()).toContain(`Next action: ${STOP_NEXT_ACTION}`)
  // Success criteria are listed for the owner to judge, never claimed.
  expect(ui.text()).toContain('Every check green on master')
  expect(ui.text()).toContain('this report never claims they are met')
})

test('a stalled plan shows the stall kind with progress apart from activity', () => {
  const hoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  const supervision = view([
    row({
      change: 'api', outcome: 'stalled', cause: { kind: 'stall', stall: 'repeating-failure' },
      alsoApplying: [{ kind: 'ci', pending: ['ci / unit-tests'] }],
      stall: { kind: 'repeating-failure', episodeKey: 'r3', signature: 'ci / unit-tests,review:fail', rounds: ['r2', 'r3'] },
      holder: { session: 'dev-1', group: 'middle-devs', profile: 'glm' },
      progress: { kind: 'ci-pass', at: hoursAgo }, activity: { kind: 'live-turn', at: new Date().toISOString() },
      lastRound: { id: 'r3', number: 3, outcome: 'fail', failing: [check('ci / unit-tests', 'fail')], flaky: [], verdict: 'fail', findingsSummary: null },
    }),
  ])
  const ui = section(supervision)
  expect(ui.text()).toContain('api · Stalled')
  expect(ui.text()).toContain('Stalled: repeating failure — ci / unit-tests,review:fail')
  expect(ui.text()).toContain('also applying: Waiting for CI: ci / unit-tests')
  expect(ui.text()).toContain('Progress 3 h ago (ci pass)')
  expect(ui.text()).toContain('activity 0 min ago (live turn)')
  expect(ui.text()).toContain('held by Dev One (glm)')
})

test('a fully landed plan reads All landed, the override count, fix durations, and the disposition', () => {
  const hoursAgo = new Date(Date.now() - 3600 * 1000).toISOString()
  const landed = (change: string): ChangeSupervision => row({
    change, outcome: 'landed', cause: { kind: 'landed', treeVerified: true },
    landing: { landedAt: hoursAgo, treeVerified: true, mergeSha: `m-${change}`, postCi: null },
  })
  const decisions = [{
    card: { addressedGroup: 'lead' as const },
    decisions: [
      { id: 'decision-2', cardId: 'card-1', planId: 'plan-1', teamId: 't', seq: 1, kind: 'answer' as const, choice: 'drop v1', optionIndex: 2,
        rationale: null, decidedBy: { kind: 'agent' as const, session: 'lead-1', group: 'lead', profile: 'glm' },
        affected: ['task-1'], commandId: null, replyMessageId: null, createdAt: '2026-10-13T00:00:00.000Z' },
      { id: 'decision-3', cardId: 'card-1', planId: 'plan-1', teamId: 't', seq: 2, kind: 'override' as const, choice: 'keep v1', optionIndex: 1,
        rationale: 'v1 must stay', decidedBy: { kind: 'human' as const, session: null, group: null, profile: null },
        affected: ['task-1'], commandId: null, replyMessageId: null, createdAt: '2026-10-13T10:00:00.000Z' },
    ],
    fixes: [{ decisionId: 'decision-3', status: {
      phase: 'landed' as const, revision: null, executionId: null,
      landings: [{ change: 'api', executionId: 'exec-1', mergeSha: 'm', landedAt: '2026-10-14T12:00:00.000Z', treeVerified: false }],
      outstanding: [],
    } }],
  }]
  const supervision = view([landed('api'), landed('ui'), landed('docs')], decisions)
  const report = { ...supervision.report, disposition: { disposition: 'reconsider' as const, reviewId: 'review-1', strategyRevision: 4 } }
  const opened: number[] = []
  const ui = section({ ...supervision, report }, revision => opened.push(revision))
  expect(ui.text()).toContain('All 3 changes landed')
  expect(ui.text()).toContain('Landed 3')
  expect(ui.text()).toContain('1 of 1 Lead decisions overridden')
  expect(ui.text()).toContain('Forward fix landed 26 h after the override')
  expect(ui.text()).toContain('a landing was not tree-verified')
  expect(ui.text()).toContain('Strategy impact review of revision 4: reconsider')
  act(() => ui.renderer.root.findByProps({ 'data-testid': 'plan-report-disposition' }).findByProps({ type: 'button' }).props.onClick())
  expect(opened).toEqual([4])
})

test('the section mounts in the plan detail only when the detail carries supervision', () => {
  useTeamPlanStore.getState().open('/repo', 'plan-1')
  const baseDetail: PlanDetail = {
    plan: planSummary('plan-1', { state: 'in-progress', currentApprovedRevision: 1 }),
    revisions: [{ revision: 1, status: 'approved', content: normalizePlanContent({ goal: 'Ship', changes: [{ change: 'api' }] }),
      contentHash: 'hash-1', pin: null, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-14T00:00:00.000Z' }],
    drafts: [], events: [], linkedTasks: [], progress: null,
  }
  const element = () => (
    <TeamPlansView teamPath="/repo" view={useTeamPlanStore.getState().views['/repo']!} sendMessage={() => undefined}
      connected connectionEpoch={0} sessions={[]} />
  )
  let renderer!: TestRenderer.ReactTestRenderer
  const apply = (withSupervision: boolean) => {
    act(() => {
      useTeamPlanStore.getState().applyDetail({ type: 'team-plan-detail', teamPath: '/repo', teamId: 't', detail: { ...baseDetail, supervision: withSupervision ? view([row({ change: 'api' })]) : undefined } })
      renderer.update(element())
    })
  }
  act(() => {
    renderer = TestRenderer.create(element(), { createNodeMock: _node => ({ focus: () => {} }) })
  })
  renderers.push(renderer)
  expect(renderer.root.findAllByProps({ 'data-testid': 'plan-report-section' })).toHaveLength(0)
  apply(true)
  expect(renderer.root.findAllByProps({ 'data-testid': 'plan-report-section' })).toHaveLength(1)
  expect(textOf(renderer.root)).toContain('Landed 0 of 3')
  apply(false)
  expect(renderer.root.findAllByProps({ 'data-testid': 'plan-report-section' })).toHaveLength(0)
})
