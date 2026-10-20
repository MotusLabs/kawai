// teamPlanStore's promotion wiring (integration-candidates 8.1, D13): the
// detail's `integration` rides the view, replacing whole on every push; the
// Promote dialog's preview lands in its own slot and never refuses or retires
// a command; Promote's command is minted at open and re-minted when `fromSha`
// changes; Cancel arms its own; a reconnect drops a pending preview; and every
// applying method still has a dispatch caller.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { PlanDetail } from '@shared/plans'
import type { PlanIntegrationView, PromotionPreview } from '@shared/planIntegration'
import { useTeamPlanStore } from '../stores/teamPlanStore'

const teamKey = '/repo'
const view = () => useTeamPlanStore.getState().views[teamKey]!

beforeEach(() => {
  useTeamPlanStore.getState().close(teamKey)
  useTeamPlanStore.getState().open(teamKey)
})
afterEach(() => useTeamPlanStore.getState().close(teamKey))

const integration: PlanIntegrationView[] = [{ branch: 'wave/c', targetBranch: 'master', head: 'a'.repeat(40), createdSha: '0'.repeat(40), candidates: [], promotions: [], promotedThroughSeq: 0 }]
const detail = (views: PlanIntegrationView[] | undefined): PlanDetail => ({
  plan: { id: 'plan-1', teamId: 't', title: 'P', lifecycle: 'open', createdAt: '', updatedAt: '', state: 'in-progress', creator: { kind: 'human', sessionId: null }, currentApprovedRevision: 1, pin: null, linkedTaskCount: 0 },
  revisions: [], drafts: [], events: [], linkedTasks: [], progress: null,
  ...(views === undefined ? {} : { integration: views }),
})
const preview: PromotionPreview = { branch: 'wave/c', targetBranch: 'master', head: 'a'.repeat(40), failures: [], throughSeq: 1, carried: [], outside: [] }
const result = (requestId: string, extra: Record<string, unknown>) =>
  useTeamPlanStore.getState().applyResult({ type: 'team-plan-result', teamPath: teamKey, requestId, ...extra } as never)

describe('teamPlanStore promotion (8.1, D13)', () => {
  test('the detail push carries integration; a push without it clears it; another plan never inherits it', () => {
    const store = useTeamPlanStore.getState()
    store.select(teamKey, 'plan-1')
    store.applyDetail({ type: 'team-plan-detail', teamPath: teamKey, teamId: 't', detail: detail(integration) })
    expect(view().detailIntegration).toEqual(integration)
    store.applyDetail({ type: 'team-plan-detail', teamPath: teamKey, teamId: 't', detail: detail(undefined) })
    expect(view().detailIntegration).toBeUndefined()
    store.applyDetail({ type: 'team-plan-detail', teamPath: teamKey, teamId: 't', detail: detail(integration) })
    store.select(teamKey, 'plan-2')
    expect(view().detailIntegration).toBeUndefined()
  })

  test('a preview answer lands in its slot; an error preview neither refuses nor retires the Promote command', () => {
    const store = useTeamPlanStore.getState()
    store.arm(teamKey, 'promote:plan-1:wave/c')
    store.beginPromotionPreview(teamKey, 'p1', 'plan-1:wave/c')
    expect(view().promotionPreviews['plan-1:wave/c']).toEqual({ state: 'pending' })
    result('p1', { promotionPreview: preview })
    expect(view().promotionPreviews['plan-1:wave/c']).toEqual({ state: 'preview', preview })
    expect(view().pending.p1).toBeUndefined()

    store.beginPromotionPreview(teamKey, 'p2', 'plan-1:wave/c')
    result('p2', { error: 'unreadable' })
    expect(view().promotionPreviews['plan-1:wave/c']).toEqual({ state: 'error', error: 'unreadable' })
    expect(view().commands['promote:plan-1:wave/c']?.refused).toBeUndefined()
    expect(view().error).toBeNull()
  })

  test('Promote is minted at open, reused for the same head, re-minted when fromSha changes, refused and retired by its result', () => {
    const store = useTeamPlanStore.getState()
    const slot = 'promote:plan-1:wave/c'
    store.arm(teamKey, slot)
    const minted = view().commands[slot]!.commandId
    const payload = (fromSha: string) => JSON.stringify({ planId: 'plan-1', branch: 'wave/c', fromSha })
    expect(store.command(teamKey, slot, payload('a'), 'q1')).toBe(minted)
    expect(store.command(teamKey, slot, payload('a'), 'q2')).toBe(minted)
    const moved = store.command(teamKey, slot, payload('b'), 'q3')
    expect(moved).not.toBe(minted)
    store.begin(teamKey, 'q3', 'promote')
    result('q3', { error: 'refused', failures: [{ name: 'no-execution', message: 'An execution runs.' }] })
    expect(view().commands[slot]?.refused).toBe(true)
    expect(view().failures.map(failure => failure.name)).toEqual(['no-execution'])

    store.arm(teamKey, slot)
    store.command(teamKey, slot, payload('b'), 'q4')
    store.begin(teamKey, 'q4', 'promote')
    result('q4', { promotion: { id: 'promo-1', number: 1, promotionBranch: 'wave/c--promote-1', state: 'running', outcome: null }, replayed: false })
    expect(view().commands[slot]).toBeUndefined()
  })

  test('Cancel arms its own command, separate from Promote', () => {
    const store = useTeamPlanStore.getState()
    store.arm(teamKey, 'promote:plan-1:wave/c')
    store.arm(teamKey, 'cancel-promotion:promo-1')
    expect(view().commands['cancel-promotion:promo-1']!.commandId).not.toBe(view().commands['promote:plan-1:wave/c']!.commandId)
    store.command(teamKey, 'cancel-promotion:promo-1', JSON.stringify({ promotionId: 'promo-1', reason: 'r' }), 'c1')
    store.begin(teamKey, 'c1', 'cancel-promotion')
    result('c1', { promotion: { id: 'promo-1', number: 1, promotionBranch: 'wave/c--promote-1', state: 'finished', outcome: 'cancelled' }, replayed: false })
    expect(view().commands['cancel-promotion:promo-1']).toBeUndefined()
    expect(view().commands['promote:plan-1:wave/c']).toBeDefined()
  })

  test('a reconnect drops a pending preview and keeps a settled one', () => {
    const store = useTeamPlanStore.getState()
    store.beginPromotionPreview(teamKey, 'p1', 'plan-1:wave/c')
    result('p1', { promotionPreview: preview })
    store.beginPromotionPreview(teamKey, 'p2', 'plan-1:wave/d')
    store.reconnected(teamKey)
    expect(view().promotionPreviews['plan-1:wave/c']?.state).toBe('preview')
    expect(view().promotionPreviews['plan-1:wave/d']).toBeUndefined()
    expect(view().pending).toEqual({})
    expect(view().promotionPreviewRequests).toEqual({})
  })

  test('every applying method has a dispatch caller in the protocol layer', () => {
    const storeFile = fs.readFileSync(path.join(process.cwd(), 'src/client/stores/teamPlanStore.ts'), 'utf8')
    const protocolFile = fs.readFileSync(path.join(process.cwd(), 'src/client/protocol/teamMessages.ts'), 'utf8')
    const applying = [...new Set([...storeFile.matchAll(/^  (apply\w+):/gm)].map(match => match[1]!))]
    expect(applying).toEqual(['applySnapshot', 'applyDetail', 'applyResult'])
    for (const method of applying) expect(protocolFile).toContain(`plans.${method}`)
  })
})
