// The one seeded command family behind properties P1 and P2
// (owner-publication-handoff design "Properties"): request and re-request,
// the prepared publish (one to three duplicates, concurrent through
// `Promise.all`), the linked-draft history through the human's own commands
// (load, same-base save, stale-form save, rebase, linked publish and its
// resend), ordinary publications (plain and draft-shaped, some trying the
// reserved prefix), the pause resolution's real Adapt on a paused change's
// task, decline, withdraw, close, ownership transfer, notices in every
// state, task mail, acknowledgements, archival and revival, neutral events
// and restart. Everything runs over one database: the pause bench's world
// (so Adapt goes through the real `PauseService.resolve`) with the decision
// services and the attention helpers built over it.
import type { AttentionItem } from '../../../shared/teamWorkspace'
import { loadHandoffDraft } from '../../team/taskHandoffDrafts'
import type { TaskPublishInput } from '../../team/TaskService'
import { createDecisionBench, type DecisionBench } from '../decisionHarness'
import { pauseResolveBench, type PauseResolveBench } from '../pauseResolveBench'
import { sessionRow, writeGroup } from '../planHarness'
import { handoffAttentionParts, type HandoffAttentionBench, type NoticeMove } from './handoffAttentionBench'

export type FamilyStep =
  | 'request' | 'rerequest' | 'publish' | 'publish-dup' | 'other' | 'adapt' | 'reserved'
  | 'load' | 'save-same' | 'stale-save' | 'rebase' | 'linked-publish'
  | 'decline' | 'withdraw' | 'close' | 'transfer' | 'neutral' | 'restart'
  | 'notice' | 'mail' | 'ack' | 'archive' | 'revive'
export const FAMILY_STEPS: FamilyStep[] = [
  'request', 'request', 'rerequest', 'publish', 'publish-dup', 'other', 'adapt', 'adapt', 'reserved',
  'load', 'load', 'save-same', 'stale-save', 'rebase', 'linked-publish', 'linked-publish',
  'decline', 'withdraw', 'close', 'transfer', 'neutral', 'restart', 'notice', 'notice', 'notice', 'mail', 'ack', 'archive', 'revive',
]
/**
 * One case's steps, the same generator for P1 and P2: half the paused cases
 * open with Adapt over an open (H20) or a stale (H21) handoff, 40% of the
 * rest with an edit-and-publish history (request, load, up to three
 * same-base saves, stale-form saves or rebases, the linked publish), some
 * of the others with a prepared publish and its notices, then 3–12 random
 * steps.
 */
export function familySteps(random: () => number, kind: FamilyCase['kind']): FamilyStep[] {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const history: FamilyStep[] = kind === 'paused' && random() < 0.5 ? (random() < 0.5 ? ['request', 'adapt'] : ['request', 'other', 'adapt'])
    : random() < 0.4
      ? ['request', 'load', ...Array.from({ length: Math.floor(random() * 4) }, () => pick(['save-same', 'stale-save', 'rebase'] as const)), 'linked-publish']
      : random() < 0.3 ? ['request', 'publish', 'notice', 'notice'] : []
  return [...history, ...Array.from({ length: 3 + Math.floor(random() * 10) }, () => pick(FAMILY_STEPS))]
}
export type Neutral = 'answer' | 'own-call' | 'override' | 'note' | 'mail' | 'archive-requester' | 'exhaust-holder' | 'acknowledge' | 'notice-retry' | 'restart'
export const NEUTRALS: Neutral[] = ['answer', 'own-call', 'override', 'note', 'mail', 'archive-requester', 'exhaust-holder', 'acknowledge', 'notice-retry', 'restart']
const NOTICES: NoticeMove[] = ['queued', 'delivered', 'uncertain', 'failed']

/** One case's task and what the generator itself knows about it (the models read these, never the source's facts). */
export interface FamilyCase {
  taskId: string
  kind: 'plain' | 'owned' | 'paused'
  /** The session the test put on the task (the holder), or none. */
  claimant: string | null
  pause: { planId: string; pauseId: string } | null
  /** The draft identity the human's current form loaded, and an older form's. */
  form: string | null
  staleForm: string | null
  lastDraftPublish: TaskPublishInput | null
}

export interface HandoffFamily {
  wired: PauseResolveBench
  bench: DecisionBench
  attention: HandoffAttentionBench
  planId: string
  live: (session: string) => boolean
  start: (random: () => number) => Promise<FamilyCase>
  step: (item: FamilyCase, kind: FamilyStep, random: () => number) => Promise<void>
  neutral: (taskId: string, event: Neutral) => Promise<void>
  /** The workspace read's handoff items, the task owned by an execution exactly when it is a paused change's. */
  items: (cases: FamilyCase[]) => AttentionItem[]
  close: () => void
}

const swallow = async (run: () => Promise<unknown>) => { try { await run() } catch { /* a refusal is part of the sequence */ } }

export async function createHandoffFamily(prefix: string): Promise<HandoffFamily> {
  const wired = await pauseResolveBench(prefix)
  const world = wired.world
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  writeGroup(world, 'change-leads', '---\ncanCreateTasks: true\n---\nCoordinate.')
  const bench = createDecisionBench(world, wired.bench)
  const attention = handoffAttentionParts(world, bench)
  for (const id of ['cl', 'cl2']) bench.records.set(id, { ...sessionRow(id, 'change-leads', world.repo), name: id })
  const planId = await bench.approvedPlan(true)
  const tasks = () => bench.taskService
  const human = bench.human
  const lead = { kind: 'agent' as const, sessionId: 'lead' }
  const dev = { kind: 'agent' as const, sessionId: 'dev' }
  let counter = 0
  const next = () => ++counter
  const live = (session: string) => { const record = bench.records.get(session); return !!record && !record.archivedAt && !record.contextExhausted }
  const pick = <T,>(random: () => number, items: readonly T[]) => items[Math.floor(random() * items.length)]!

  async function neutral(taskId: string, event: Neutral): Promise<void> {
    const n = next()
    const record = (id: string) => bench.records.get(id)!
    switch (event) {
      case 'answer': {
        const asked = await bench.decide.ask(dev, { question: `Publish the prepared correction ${n}?`, options: ['Publish', 'Wait'] })
        return swallow(() => bench.decide.record(lead, { plan_id: planId, card_id: asked.card.id, option_index: 1, rationale: 'Publish it', affected_tasks: [taskId] }))
      }
      case 'own-call':
        return swallow(() => bench.decide.record(lead, { plan_id: planId, question: `Publish ${n}?`, options: ['Publish', 'Wait'], option_index: 1, rationale: 'yes', affected_tasks: [taskId] }))
      case 'override': {
        const asked = await bench.decide.ask(dev, { question: `Publish it ${n}?`, options: ['Publish', 'Wait'] })
        const first = await bench.decide.record(lead, { plan_id: planId, card_id: asked.card.id, option_index: 2, rationale: 'Wait' })
        return swallow(() => bench.decide.override(human, { planId, cardId: asked.card.id, expectedDecisionId: first.decision.id, optionIndex: 1, rationale: 'Publish', commandId: `ov-${n}` }))
      }
      case 'note':
        return swallow(() => tasks().note(dev, taskId, `Please publish ${n}`))
      case 'mail':
        return swallow(() => bench.mailbox.send(dev, { to_kind: 'session', to_id: 'lead', body: `publish it ${n}`, task_id: taskId }))
      case 'archive-requester':
        bench.records.set('lead', { ...record('lead'), archivedAt: new Date().toISOString() })
        return
      case 'exhaust-holder':
        bench.records.set('dev', { ...record('dev'), contextExhausted: { at: new Date().toISOString(), reason: 'prompt_too_long' } })
        return
      case 'acknowledge':
        return swallow(() => tasks().acknowledge(dev, taskId, tasks().store.get(taskId)!.revision))
      case 'notice-retry':
        return swallow(() => tasks().notify(human, taskId, tasks().store.get(taskId)!.revision, `retry-${n}`))
      case 'restart':
        tasks().handoffs.reconcile()
    }
  }

  function reviveAll(): void {
    for (const id of ['lead', 'lead2', 'dev', 'cl', 'cl2']) {
      const { archivedAt: _archived, contextExhausted: _exhausted, ...rest } = bench.records.get(id)!
      bench.records.set(id, rest)
    }
  }

  async function start(random: () => number): Promise<FamilyCase> {
    reviveAll()
    const roll = random()
    const blank = { form: null, staleForm: null, lastDraftPublish: null }
    if (roll < 0.25) {
      const paused = await wired.pausedAttempt({ holder: 'dev' })
      return { taskId: paused.taskId, kind: 'paused', claimant: 'dev', pause: { planId: paused.planId, pauseId: paused.pauseId }, ...blank }
    }
    if (roll < 0.5) {
      const task = await tasks().create({ kind: 'agent', sessionId: 'cl' }, { title: `Owned ${next()}`, direction: 'v1' })
      const claimant = random() < 0.7 ? 'dev' : null
      if (claimant) attention.claim(task.id, claimant)
      return { taskId: task.id, kind: 'owned', claimant, pause: null, ...blank }
    }
    const taskId = await bench.onTask('dev', planId)
    if (random() < 0.5) tasks().store.db.prepare('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run('lead2', taskId)
    const claimant = random() < 0.8 ? 'dev' : null
    if (claimant) attention.claim(taskId, claimant)
    return { taskId, kind: 'plain', claimant, pause: null, ...blank }
  }

  async function step(item: FamilyCase, kind: FamilyStep, random: () => number): Promise<void> {
    const { taskId } = item
    const pending = tasks().handoffs.store.pendingOf(taskId)
    const revision = tasks().store.get(taskId)!.revision
    const draft = tasks().store.drafts.get(taskId)
    const n = next()
    const requestAs = (session: string) => swallow(() => tasks().handoffs.request({ kind: 'agent', sessionId: session }, taskId, {
      baseRevision: random() < 0.85 ? revision : Math.max(1, revision - 1), direction: `Prepared ${n}`, rationale: 'why', notify: random() < 0.5, requestKey: `k${n}`,
    }))
    switch (kind) {
      case 'request': return requestAs('lead')
      case 'rerequest': return requestAs('lead2')
      case 'publish':
        return pending ? swallow(() => tasks().handoffs.publish(human, taskId, pending.id, [])) : undefined
      case 'publish-dup': {
        const target = pending ?? (tasks().store.db.prepare('SELECT id FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid DESC').get(taskId) as { id: string } | null)
        if (!target) return
        await Promise.all(Array.from({ length: 1 + Math.floor(random() * 3) }, () => swallow(() => tasks().handoffs.publish(human, taskId, target.id, []))))
        return
      }
      case 'other':
        return swallow(() => tasks().publish(human, taskId, { direction: `Other ${n}`, rationale: 'mine', notify: random() < 0.5, requestKey: `o${n}` }))
      case 'adapt':
        if (!item.pause) return
        // Adapt supersedes the holder's assignment and dispatches a new attempt nobody has claimed yet.
        if ((await wired.service.resolve(human, {
          planId: item.pause.planId, pauseId: item.pause.pauseId, change: 'api', choice: 'adapt', adapt: `Adapted ${n}`, rationale: 'rethink', commandId: `adapt-${n}`,
        })).ok) item.claimant = null
        return
      case 'reserved': {
        const id = pending?.id ?? 'handoff-none'
        const key = pick(random, [`handoff:${id}`, ` handoff:${id}`, `\thandoff:${id}\n`, `handoff:${id}  `])
        const asDraft = random() < 0.5 && draft
        return swallow(() => tasks().publish(human, taskId, {
          requireRationale: true, direction: draft?.direction ?? `Reserved ${n}`, rationale: random() < 0.5 ? ' ' : 'r', notify: false, requestKey: key,
          ...(asDraft ? { fromDraft: true, observedDraft: item.form, baseRevision: draft.baseRevision } : {}),
        }))
      }
      case 'load': {
        if (!pending) return
        try {
          const loaded = await loadHandoffDraft(tasks(), human, taskId, pending.id, random() < 0.8)
          item.staleForm = item.form
          item.form = loaded.lineageId ?? null
        } catch { /* H18, H37 */ }
        return
      }
      case 'save-same':
        if (!draft) return
        return swallow(() => tasks().saveDraft(human, taskId, {
          direction: `${draft.direction} edited ${n}`, acceptance: draft.acceptance, rationale: draft.rationale, baseRevision: draft.baseRevision, observedDraft: item.form,
        }))
      case 'stale-save':
        return swallow(() => tasks().saveDraft(human, taskId, {
          direction: `Old form ${n}`, rationale: 'old', baseRevision: draft?.baseRevision ?? revision, observedDraft: random() < 0.5 ? item.staleForm : null,
        }))
      case 'rebase':
        return swallow(() => tasks().rebaseDraft(human, taskId, random() < 0.8 ? item.form : item.staleForm))
      case 'linked-publish': {
        const resend = item.lastDraftPublish && random() < 0.3
        const input: TaskPublishInput | null = resend ? item.lastDraftPublish : draft ? {
          requireRationale: true, direction: draft.direction, acceptance: draft.acceptance, rationale: draft.rationale ?? 'edited',
          baseRevision: draft.baseRevision, requestKey: random() < 0.2 && item.lastDraftPublish ? item.lastDraftPublish.requestKey : `d${n}`,
          notify: random() < 0.5, fromDraft: true, observedDraft: random() < 0.8 ? item.form : item.staleForm,
        } : null
        if (!input) return
        item.lastDraftPublish = input
        return swallow(() => tasks().publish(human, taskId, input))
      }
      case 'decline':
        return pending ? swallow(() => tasks().handoffs.settle(human, pending.id, 'decline', 'no')) : undefined
      case 'withdraw':
        return pending ? swallow(() => tasks().handoffs.settle({ kind: 'agent', sessionId: pending.requesterSession }, pending.id, 'withdraw', 'not needed')) : undefined
      case 'close':
        return swallow(() => tasks().setStatus(human, taskId, random() < 0.5 ? 'cancelled' : 'done'))
      case 'transfer':
        return swallow(() => tasks().ownership.transfer({ kind: 'agent', sessionId: 'cl' }, { task_id: taskId, to_session: 'cl2' }))
      case 'neutral':
        return neutral(taskId, pick(random, NEUTRALS))
      case 'restart':
        tasks().handoffs.reconcile()
        return
      case 'notice':
        if (item.claimant && revision > 1) { try { attention.notice(taskId, revision, pick(random, NOTICES)) } catch { /* nobody holds it */ } }
        return
      case 'mail':
        if (item.claimant) attention.taskMail(taskId, item.claimant, revision, random() < 0.7)
        return
      case 'ack':
        if (item.claimant && live(item.claimant)) await swallow(() => attention.acknowledge(taskId, item.claimant!, revision))
        return
      case 'archive':
        attention.gone(pending && random() < 0.5 ? pending.requesterSession : pick(random, ['lead', 'lead2', 'dev']))
        return
      case 'revive':
        reviveAll()
    }
  }

  return {
    wired, bench, attention, planId, live, start, step, neutral,
    items: cases => attention.items(taskId => cases.some(entry => entry.taskId === taskId && entry.kind === 'paused')),
    close: () => wired.close(),
  }
}
