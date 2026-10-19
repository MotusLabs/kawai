// The integration panel's component scenarios (integration-candidates 8.2,
// D11, D13): the chain newest first with a failed candidate beside its
// replacement and outside commits flagged; Promote offered only while a
// landed change is left to promote and nothing of the plan runs; the dialog's
// carried changes, outside commits, and pinned head; a `no-execution`
// refusal inline; two of three landed changes marked promoted; and every
// control disabled while disconnected. Renderers are created inside act() so
// later store updates re-render (the bun act trap).
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { createElement } from 'react'
import PlanIntegrationPanel from '../components/team/PlanIntegrationPanel'
import PlanExecutionSection from '../components/team/PlanExecutionSection'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import type { ClientMessage } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import type { PlanExecutionView } from '@shared/planExecution'
import type { IntegrationCandidate, PlanIntegrationView, PromotionView } from '@shared/planIntegration'

const teamPath = '/repo'
const otherTeam = '/other-repo'
let renderer: TestRenderer.ReactTestRenderer | null = null
let sent: ClientMessage[] = []
const render = (node: ReturnType<typeof createElement>) => act(() => { renderer = TestRenderer.create(node) })
const byId = (id: string) => renderer!.root.findAll(node => node.props['data-testid'] === id && typeof node.type === 'string')
type Json = TestRenderer.ReactTestRendererJSON
const flat = (node: Json | string): string => typeof node === 'string' ? node : (node.children ?? []).map(flat).join('')
/** The rendered text of every host node carrying `data-testid` = id, in order. */
const textsOf = (id: string): string[] => {
  const found: string[] = []
  const walk = (node: Json | Json[] | string | null) => {
    if (node === null || typeof node === 'string') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props['data-testid'] === id) found.push(flat(node))
    ;(node.children ?? []).forEach(walk)
  }
  walk(renderer?.toJSON() ?? null)
  return found
}
const textOf = (id: string) => textsOf(id)[0] ?? ''
const click = (id: string) => act(() => { byId(id)[0]!.props.onClick() })
const update = (node: ReturnType<typeof createElement>) => act(() => { renderer!.update(node) })

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  sent = []
  useTeamPlanStore.getState().close(teamPath)
  useTeamPlanStore.getState().close(otherTeam)
})

const sha = (char: string) => char.repeat(40)
const candidate = (seq: number, over: Partial<IntegrationCandidate> = {}): IntegrationCandidate => ({
  id: `cand-${seq}`, teamId: 't', branch: 'wave/c', seq, kind: 'increment', executionId: 'exec-1', change: 'api', resultId: null,
  roundId: null, promotionId: null, baselineSha: sha('0'), commitSha: sha(String(seq)), treeSha: sha('f'), outside: null,
  state: 'landed', createdAt: '', decidedAt: null, ...over,
})
const promotion = (over: Partial<PromotionView> = {}): PromotionView => ({
  id: 'promo-1', teamId: 't', planId: 'plan-1', branch: 'wave/c', number: 1, commandId: 'c', fromSha: sha('2'), throughSeq: 2,
  targetBranch: 'master', promotionBranch: 'wave/c--promote-1', prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', headSha: null,
  step: 'ci', moves: 0, state: 'running', outcome: null, outcomeDetail: null, mergeSha: null, treeVerified: null, fastForwarded: null,
  fastForwardNote: null, cancelReason: null, startedAt: '', finishedAt: null, ci: null, ...over,
})
const integrationView = (over: Partial<PlanIntegrationView> = {}): PlanIntegrationView => ({
  branch: 'wave/c', targetBranch: 'master', head: sha('3'), createdSha: sha('0'),
  candidates: [candidate(3, { change: 'ui' }), candidate(2, { change: 'api' })], promotions: [], promotedThroughSeq: 0, ...over,
})
const panel = (views: PlanIntegrationView[], options: { running?: boolean; connected?: boolean; teamPath?: string } = {}) =>
  createElement(PlanIntegrationPanel, {
    teamPath: options.teamPath ?? teamPath, planId: 'plan-1', views, executionRunning: options.running ?? false, connected: options.connected ?? true,
    onSend: (message: ClientMessage) => { sent.push(message) },
  })
const openStore = () => useTeamPlanStore.getState().open(teamPath, 'plan-1')
const answer = (requestId: string, payload: Record<string, unknown>) =>
  act(() => useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath, requestId, ...payload } as never))
const requestOf = (type: ClientMessage['type']) => (sent.find(message => message.type === type) as { requestId: string } | undefined)?.requestId ?? ''

describe('PlanIntegrationPanel (8.2, D13)', () => {
  test('the chain is newest first, a failed candidate stays beside its replacement, outside commits are flagged', () => {
    const outside = [{ sha: sha('9'), author: 'Owner', subject: 'hand fix' }]
    render(panel([integrationView({ candidates: [
      candidate(3, { change: 'api', state: 'landed', outside }),
      candidate(2, { change: 'api', state: 'failed' }),
      candidate(1, { change: 'db', state: 'landed' }),
    ] })]))
    const rows = textsOf('plan-integration-candidate')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toStartWith('#3')
    expect(rows[1]).toStartWith('#2')
    expect(rows[1]).toContain('CI failed · failed')
    expect(rows[2]).toStartWith('#1')
    expect(textsOf('plan-integration-outside')).toHaveLength(1)
    expect(textOf('plan-integration-outside')).toContain('1 outside commit')
    expect(byId('plan-integration-outside')[0]!.props.title).toContain('hand fix')
  })

  test('Promote is offered only while something is left to promote and nothing of the plan runs', () => {
    render(panel([integrationView()]))
    expect(textOf('plan-promote-open')).toContain('Promote to master')
    update(panel([integrationView({ promotedThroughSeq: 3 })]))
    expect(byId('plan-promote-open')).toHaveLength(0)
    update(panel([integrationView({ promotions: [promotion()] })]))
    expect(byId('plan-promote-open')).toHaveLength(0)
    update(panel([integrationView()], { running: true }))
    expect(byId('plan-promote-open')).toHaveLength(0)
    expect(byId('plan-promote-waits')).toHaveLength(1)
    update(panel([integrationView({ candidates: [candidate(1, { state: 'verifying' })] })]))
    expect(byId('plan-promote-open')).toHaveLength(0)
  })

  test('the dialog lists the carried changes, flags an outside commit, names the pinned head, and sends it as fromSha', () => {
    openStore()
    render(panel([integrationView()]))
    click('plan-promote-open')
    expect(sent.find(message => message.type === 'team-plan-promotion-preview')).toMatchObject({ teamPath, planId: 'plan-1', branch: 'wave/c' })
    expect(byId('plan-promote-confirm')[0]!.props.disabled).toBe(true)
    const outside = [{ sha: sha('9'), author: 'Owner', subject: 'hand fix' }]
    answer(requestOf('team-plan-promotion-preview'), { promotionPreview: { branch: 'wave/c', targetBranch: 'master', head: sha('3'), failures: [], throughSeq: 3,
      carried: [candidate(3, { change: 'ui', outside }), candidate(2, { change: 'api' })], outside } })
    expect(textOf('plan-promote-head')).toContain(sha('3'))
    expect(textOf('plan-promote-carried')).toContain('ui (#3')
    expect(textOf('plan-promote-carried')).toContain('api (#2')
    expect(textOf('plan-promote-outside')).toContain('hand fix')
    click('plan-promote-confirm')
    const promote = sent.find(message => message.type === 'team-plan-promote') as { commandId: string } | undefined
    expect(promote).toMatchObject({ planId: 'plan-1', branch: 'wave/c', fromSha: sha('3') })
    expect(promote!.commandId).toBe(useTeamPlanStore.getState().views[teamPath]!.commands['promote:plan-1:wave/c']!.commandId)
  })

  test('an open dialog re-keyed to another team asks that team for its preview (review O1)', () => {
    openStore()
    useTeamPlanStore.getState().open(otherTeam, 'plan-1')
    render(panel([integrationView()]))
    click('plan-promote-open')
    // The team switch keeps the view mounted; the other team's slot is armed as its own open would.
    act(() => useTeamPlanStore.getState().arm(otherTeam, 'promote:plan-1:wave/c'))
    update(panel([integrationView()], { teamPath: otherTeam }))
    const previews = sent.filter(message => message.type === 'team-plan-promotion-preview').map(message => (message as { teamPath: string }).teamPath)
    expect(previews).toEqual([teamPath, otherTeam])
  })

  test('a no-execution refusal shows inline and turns Promote off', () => {
    openStore()
    render(panel([integrationView()]))
    click('plan-promote-open')
    answer(requestOf('team-plan-promotion-preview'), { promotionPreview: { branch: 'wave/c', targetBranch: 'master', head: sha('3'), failures: [], throughSeq: 3, carried: [], outside: [] } })
    click('plan-promote-confirm')
    answer(requestOf('team-plan-promote'), { error: 'Promote refused', failures: [{ name: 'no-execution', message: 'An execution of the plan is running.' }] })
    expect(textOf('plan-promote-refused')).toContain('no-execution: An execution of the plan is running.')
    expect(byId('plan-promote-confirm')[0]!.props.disabled).toBe(true)
  })

  test('the promotion row shows its step, PR, CI with flaky marks, and Cancel asks for a reason', () => {
    openStore()
    const ci = { checks: [
      { name: 'ci', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
      { name: 'ci', source: 'status', conclusion: 'success', link: null, startedAt: null, completedAt: null },
    ], flaky: ['ci'] } as unknown as PromotionView['ci']
    render(panel([integrationView({ promotions: [promotion({ ci, moves: 1 })] })]))
    const row = textOf('plan-promotion-row')
    expect(row).toContain('CI running')
    expect(row).toContain('PR #7')
    expect(row).toContain('target moved 1×')
    expect(textOf('plan-promotion-ci')).toContain('ci (flaky)')
    click('plan-promotion-cancel-open')
    expect(byId('plan-promotion-cancel-confirm')[0]!.props.disabled).toBe(true)
    act(() => { renderer!.root.findByProps({ 'aria-label': 'Cancel reason' }).props.onChange({ target: { value: 'not today' } }) })
    click('plan-promotion-cancel-confirm')
    expect(sent.find(message => message.type === 'team-plan-promotion-cancel')).toMatchObject({ promotionId: 'promo-1', reason: 'not today' })
  })

  test('every control disables while disconnected', () => {
    openStore()
    render(panel([integrationView({ promotions: [promotion()] })], { connected: false }))
    expect(byId('plan-promotion-cancel-open')[0]!.props.disabled).toBe(true)
    update(panel([integrationView()], { connected: false }))
    expect(byId('plan-promote-open')[0]!.props.disabled).toBe(true)
    update(panel([integrationView()], { connected: true }))
    click('plan-promote-open')
    update(panel([integrationView()], { connected: false }))
    expect(byId('plan-promote-confirm')[0]!.props.disabled).toBe(true)
  })
})

describe('progress promoted marks (8.2, D11)', () => {
  test('two of three landed changes are marked promoted', () => {
    const row = (change: string, position: number) => ({
      change, position, state: 'landed', step: null, waiting: null, stopReason: null, stopDetail: null, taskId: null, worktree: null, branch: change,
      baselineCommit: null, prNumber: null, prUrl: null, fixRounds: 0, generation: 1, passedAt: null, attempts: 1, attempt: null, instruction: null,
      latestRound: null, effects: [],
      landing: { planId: 'plan-1', change, executionId: 'exec-1', mechanism: 'integration-branch', prNumber: null, prUrl: null,
        headSha: sha('1'), baseSha: sha('0'), mergeSha: sha('1'), landedAt: '', treeVerified: true, postCi: null },
    }) as unknown as PlanExecutionView['changes'][number]
    const execution = {
      id: 'exec-1', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'integration-branch', baseBranch: 'wave/c',
      baseCommit: sha('0'), floor: { version: 1, map: {} }, maxParallel: 2, mergeMethod: 'merge', state: 'finished', outcome: 'completed', stopReason: null,
      startedAt: '', finishedAt: '', changes: [row('api', 0), row('ui', 1), row('db', 2)],
    } as unknown as PlanExecutionView
    const plan = { id: 'plan-1', teamId: 't', title: 'P', lifecycle: 'open', createdAt: '', updatedAt: '', state: 'in-progress',
      creator: { kind: 'human', sessionId: null }, currentApprovedRevision: 1, pin: null, linkedTaskCount: 0 } as PlanSummary
    const detail = {
      plan, revisions: [{ revision: 1, contentHash: 'h' }], drafts: [], events: [], linkedTasks: [], progress: null, executions: [execution],
      integration: [integrationView({ candidates: [candidate(3, { change: 'db' }), candidate(2, { change: 'ui' }), candidate(1, { change: 'api' })], promotedThroughSeq: 2 })],
    } as unknown as PlanDetail
    render(createElement(PlanExecutionSection, { teamPath, plan, detail, connected: true, onSend: () => undefined }))
    const rows = textsOf('plan-execution-change')
    expect(rows).toHaveLength(3)
    const marked = rows.filter(text => text.includes(' · promoted'))
    expect(marked).toHaveLength(2)
    expect(marked.some(text => text.startsWith('api'))).toBe(true)
    expect(marked.some(text => text.startsWith('ui'))).toBe(true)
    expect(rows.find(text => text.startsWith('db'))).not.toContain('promoted')
  })
})
