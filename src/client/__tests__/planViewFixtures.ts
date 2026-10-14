// Plan list and detail fixtures for the Plans view tests (durable-plans 8.x).
import type { PlanDetail, PlanSummary } from '@shared/plans'
import { normalizePlanContent } from '@shared/plans'

export const planSummary = (id: string, extra: Partial<PlanSummary> = {}): PlanSummary => ({
  id, teamId: '/repo/.git', title: `Plan ${id}`, lifecycle: 'open', currentApprovedRevision: null,
  creator: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
  state: 'draft', pin: null, linkedTaskCount: 0, ...extra,
})

export const planDetail = (plan: PlanSummary, extra: Partial<PlanDetail> = {}): PlanDetail => ({
  plan, revisions: [{ revision: 1, status: 'in_review', content: normalizePlanContent({ goal: 'Ship' }), contentHash: 'hash-1', pin: null,
    author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-14T00:00:00.000Z' }],
  drafts: [], events: [], linkedTasks: [], progress: null, ...extra,
})
