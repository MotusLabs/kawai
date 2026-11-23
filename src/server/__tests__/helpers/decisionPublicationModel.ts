import { expect } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { DecisionPublicationReceipt } from '../../../shared/planDecisions'
import type { TaskHandoff } from '../../../shared/taskHandoffs'
import { PREPARED } from './decisionPublicationBench'

export const COMMANDS = ['prepare', 'replace', 'ask', 'ask changed', 'review', 'approve', 'approve changed', 'answer', 'override',
  'ordinary', 'standalone', 'draft', 'linked', 'withdraw', 'decline', 'close', 'hold', 'fault', 'reopen'] as const
export type Command = (typeof COMMANDS)[number]
type Disposition = 'open' | 'published' | 'stale' | 'closed' | 'superseded' | 'withdrawn' | 'declined'

interface Decision {
  first: 'approval' | 'answer'
  overrides: number
}

interface Intent {
  token: string
  base: number
  states: Disposition[]
  card: { question: 'ask' | 'ask changed'; decision: Decision | null } | null
}

interface Revision {
  direction: string
  acceptance: string | null
  key: string | null
  intent: string | null
  notify: boolean | null
}

export interface Model {
  revisions: Revision[]
  intents: Intent[]
  closed: boolean
  held: boolean
  draft: { intent: string; base: number } | null
}

export const initial = (): Model => ({
  revisions: [{ direction: 'Original direction', acceptance: 'Original acceptance', key: null, intent: null, notify: null }],
  intents: [], closed: false, held: false, draft: null,
})
export const disposition = (intent: Intent) => intent.states.at(-1)!
export const current = (model: Model) => model.intents.at(-1)
export const ready = (model: Model, intent: Intent) =>
  !model.closed && model.revisions.length === intent.base && disposition(intent) === 'open'

type Outcome = 'write' | 'replay' | 'refused' | 'read'
const pending = (intent: Intent) => ['open', 'stale'].includes(disposition(intent))

function addRevision(model: Model, revision: Revision) {
  const intent = current(model)
  if (intent && disposition(intent) === 'open') intent.states.push(intent.token === revision.intent ? 'published' : 'stale')
  model.revisions.push(revision)
}

const prepared = (intent: Intent): Revision => ({
  direction: PREPARED.direction, acceptance: PREPARED.acceptance, key: `handoff:${intent.token}`, intent: intent.token, notify: true,
})

/** The reference ledger uses only the requested command and its prior model state. */
export function apply(model: Model, command: Command, token: string): Outcome {
  const intent = current(model)
  const card = intent?.card
  switch (command) {
    case 'prepare':
    case 'replace':
      if (model.closed) return 'refused'
      if (intent && pending(intent)) intent.states.push('superseded')
      model.intents.push({ token, base: model.revisions.length, states: ['open'], card: null })
      return 'write'
    case 'ask':
    case 'ask changed':
      if (card) return card.question === command ? 'replay' : 'refused'
      if (!intent || !ready(model, intent)) return 'refused'
      intent.card = { question: command, decision: null }
      return 'write'
    case 'review': return card ? 'read' : 'refused'
    case 'reopen': return 'read'
    case 'approve':
      if (card?.decision?.first === 'approval') return 'replay'
      if (!card || card.decision || !intent || !ready(model, intent)) return 'refused'
      card.decision = { first: 'approval', overrides: 0 }
      addRevision(model, prepared(intent))
      return 'write'
    case 'approve changed': return 'refused'
    case 'fault': return card?.decision?.first === 'approval' ? 'replay' : 'refused'
    case 'answer':
      if (card?.decision?.first === 'answer') return 'replay'
      if (!card || card.decision) return 'refused'
      card.decision = { first: 'answer', overrides: 0 }
      return 'write'
    case 'override':
      if (!card?.decision) return 'refused'
      card.decision.overrides++
      return 'write'
    case 'ordinary':
      addRevision(model, { key: token, direction: 'Independent direction', acceptance: null, intent: null, notify: false })
      return 'write'
    case 'standalone':
      if (intent && model.revisions.some(revision => revision.key === `handoff:${intent.token}`)) return 'replay'
      if (!intent || !ready(model, intent)) return 'refused'
      addRevision(model, prepared(intent))
      return 'write'
    case 'draft':
      if (!intent || disposition(intent) !== 'open') return 'refused'
      model.draft = { intent: intent.token, base: intent.base }
      return 'write'
    case 'linked': {
      if (!model.draft || model.draft.base !== model.revisions.length) return 'refused'
      const linked = intent?.token === model.draft.intent && disposition(intent) === 'open' ? intent.token : null
      addRevision(model, { key: token, direction: 'Edited linked direction', acceptance: PREPARED.acceptance, intent: linked, notify: true })
      model.draft = null
      return 'write'
    }
    case 'withdraw':
    case 'decline':
      if (!intent || !pending(intent)) return 'refused'
      intent.states.push(command === 'withdraw' ? 'withdrawn' : 'declined')
      return 'write'
    case 'close':
      model.closed = true
      if (intent && pending(intent)) intent.states.push('closed')
      return 'write'
    case 'hold':
      if (model.held) return 'replay'
      model.held = true
      return 'write'
  }
}

type Row = Record<string, string | number | null>
export type Handles = Map<string, { handoff: TaskHandoff; cardId?: string; bindingHash?: string }>
const WAKES = new Set(['published', 'stale', 'closed', 'declined'])

export function compareLedger(db: Database, model: Model, ids: Handles, taskId: string, planId: string) {
  const select = (sql: string, ...params: string[]) => db.prepare<Row, string[]>(sql).all(...params)
  const revisions = select('SELECT direction, acceptance, request_key AS key, handoff_id AS intent, notify, author_kind FROM team_task_revisions WHERE task_id = ? ORDER BY revision', taskId)
  expect(revisions).toEqual(model.revisions.map(revision => ({
    direction: revision.direction, acceptance: revision.acceptance,
    key: revision.key?.startsWith('handoff:') ? `handoff:${ids.get(revision.intent!)!.handoff.id}` : revision.key,
    intent: revision.intent === null ? null : ids.get(revision.intent)!.handoff.id,
    notify: revision.notify === null ? null : Number(revision.notify), author_kind: 'human',
  })))
  expect(select('SELECT revision, status, owner_session FROM team_tasks WHERE id = ?', taskId))
    .toEqual([{ revision: model.revisions.length, status: model.closed ? 'cancelled' : 'open', owner_session: null }])
  expect(select('SELECT handoff_id, base_revision FROM team_task_drafts WHERE task_id = ?', taskId)).toEqual(model.draft
    ? [{ handoff_id: ids.get(model.draft.intent)!.handoff.id, base_revision: model.draft.base }] : [])
  expect(select('SELECT id, state, base_revision, published_revision FROM team_task_handoffs WHERE task_id = ? ORDER BY rowid', taskId))
    .toEqual(model.intents.map(intent => {
      const index = model.revisions.findIndex(revision => revision.intent === intent.token)
      return { id: ids.get(intent.token)!.handoff.id, state: disposition(intent), base_revision: intent.base, published_revision: index < 0 ? null : index + 1 }
    }))
  expect(select('SELECT id FROM plan_holds WHERE plan_id = ?', planId)).toHaveLength(model.held ? 1 : 0)
  const cardRows = select('SELECT card_id, handoff_id, receipt_json, decision_id FROM plan_decision_publications WHERE task_id = ? ORDER BY rowid', taskId)
  expect(cardRows.map(row => row.card_id)).toEqual(model.intents.flatMap(intent => intent.card ? [ids.get(intent.token)!.cardId!] : []))
  expect(select('SELECT id FROM plan_decision_cards WHERE task_id = ? ORDER BY rowid', taskId).map(row => row.id)).toEqual(cardRows.map(row => row.card_id))
  const messages = select('SELECT id, to_id, task_id, tags, body FROM team_messages ORDER BY rowid')
  let answers = 0
  let wakeups = 0
  for (const intent of model.intents) {
    const handles = ids.get(intent.token)!
    const handoffId = handles.handoff.id
    expect(select('SELECT to_state FROM team_task_handoff_events WHERE handoff_id = ? ORDER BY seq', handoffId).map(row => row.to_state))
      .toEqual(intent.states)
    const wakes = select('SELECT transition, message_id FROM team_task_handoff_wakeups WHERE handoff_id = ? ORDER BY rowid', handoffId)
    expect(wakes.map(row => row.transition)).toEqual(intent.states.filter(state => WAKES.has(state)))
    wakeups += wakes.length
    for (const wakeup of wakes) expect(messages.find(row => row.id === wakeup.message_id)).toMatchObject({
      to_id: 'lead', task_id: null, body: expect.stringContaining(handoffId),
    })
    if (!intent.card) continue
    const stored = cardRows.find(row => row.card_id === handles.cardId)!
    expect(stored.handoff_id).toBe(handoffId)
    const decisions = select('SELECT id, seq, kind, command_id, choice, reply_message_id FROM plan_decisions WHERE card_id = ? ORDER BY seq', handles.cardId!)
    const decision = intent.card.decision
    expect(decisions.map(row => row.kind)).toEqual(decision ? ['answer', ...Array.from({ length: decision.overrides }, () => 'override')] : [])
    if (decision?.first === 'approval') {
      const receipt = JSON.parse(String(stored.receipt_json)) as DecisionPublicationReceipt
      const first = decisions[0]!
      expect(first).toMatchObject({ seq: 1, choice: 'Approve and publish', command_id: `approve:${intent.token}`, reply_message_id: null })
      expect(stored.decision_id).toBe(first.id)
      expect(receipt).toMatchObject({ decisionId: first.id, planId, cardId: handles.cardId, taskId, handoffId,
        baseRevision: intent.base, publishedRevision: intent.base + 1, commandId: first.command_id, bindingHash: handles.bindingHash,
        payloadHash: handles.handoff.payloadHash, noticeMessageIds: [], wakeupMessageId: wakes.find(row => row.transition === 'published')?.message_id })
    } else {
      expect([stored.receipt_json, stored.decision_id]).toEqual([null, null])
      if (decision?.first === 'answer') {
        answers++
        expect(messages.find(row => row.id === decisions[0]?.reply_message_id)).toMatchObject({
          to_id: 'lead', task_id: null, body: expect.stringContaining(handles.cardId!),
        })
      }
    }
    expect(select('SELECT f.task_id FROM plan_fix_tasks f JOIN plan_decisions d ON f.source_id = d.id WHERE d.card_id = ?', handles.cardId!))
      .toHaveLength(decision?.overrides ?? 0)
  }
  expect(messages.filter(row => String(row.tags).includes('handoff-'))).toHaveLength(wakeups)
  expect(messages.filter(row => String(row.tags).includes('decision-answer'))).toHaveLength(answers)
  expect(select('SELECT * FROM team_task_notifications WHERE task_id = ?', taskId)).toEqual([])
  expect(select('SELECT * FROM team_task_acknowledgements WHERE task_id = ?', taskId)).toEqual([])
}
