// Decision store (plan-supervision 3.2): cards, decisions, and fix tasks;
// the database arbitrates the card race, command replay, and one fix task
// per source, each surfacing as a named conflict; reads are team-scoped.
import { beforeEach, describe, expect, test } from 'bun:test'
import { DecisionConflict, DecisionStore, type NewCard, type NewDecision } from '../plans/decisions/decisionStore'
import { schemaDb } from './schemaDb'

let store: DecisionStore
beforeEach(() => { store = new DecisionStore(schemaDb(), () => new Date('2026-10-19T00:00:00.000Z')) })

const card = (extra: Partial<NewCard> = {}): NewCard => ({
  id: 'card-1', teamId: 't', planId: 'p', revision: 2, change: 'api', taskId: 'task-a', question: 'Which schema?', options: ['A', 'B'],
  context: null, askedBy: { session: 'dev', group: 'middle-devs', profile: 'glm' }, addressedTo: 'lead', addressedGroup: 'lead',
  messageId: 'msg-1', ...extra,
})

const lead = { kind: 'agent' as const, session: 'lead-1', group: 'lead', profile: 'opus' }
const human = { kind: 'human' as const, session: null, group: null, profile: null }
const decision = (extra: Partial<NewDecision> = {}): NewDecision => ({
  cardId: 'card-1', planId: 'p', teamId: 't', seq: 1, kind: 'answer', choice: 'A', optionIndex: 0, rationale: 'simpler', decidedBy: lead,
  affected: ['api'], ...extra,
})

function conflict(fn: () => unknown): DecisionConflict {
  try { fn() } catch (error) {
    expect(error).toBeInstanceOf(DecisionConflict)
    return error as DecisionConflict
  }
  throw new Error('expected a DecisionConflict')
}

describe('cards', () => {
  test('insert and read back, by id, by question message, and per plan', () => {
    const inserted = store.insertCard(card())
    expect(inserted).toEqual({ ...card(), id: 'card-1', createdAt: '2026-10-19T00:00:00.000Z' })
    expect(store.cardByMessage('t', 'msg-1')).toEqual(inserted)
    expect(store.cardsOfPlan('t', 'p').map(found => found.id)).toEqual(['card-1'])
  })

  test("another team's card reads as not found", () => {
    store.insertCard(card())
    expect(store.card('other', 'card-1')).toBeNull()
    expect(store.cardByMessage('other', 'msg-1')).toBeNull()
    expect(store.cardsOfPlan('other', 'p')).toEqual([])
  })
})

describe('decisions', () => {
  beforeEach(() => { store.insertCard(card()) })

  test('the first decision and an override chain in seq order', () => {
    store.insertDecision(decision({ id: 'd1' }))
    store.insertDecision(decision({ id: 'o1', seq: 2, kind: 'override', choice: 'B', decidedBy: human, commandId: 'cmd-1', payload: { choice: 'B' } }))
    expect(store.decisionsOfCard('t', 'card-1').map(found => [found.id, found.seq, found.kind])).toEqual([['d1', 1, 'answer'], ['o1', 2, 'override']])
    expect(store.decision('t', 'o1')!.decidedBy).toEqual(human)
    expect(store.decision('t', 'd1')!.affected).toEqual(['api'])
  })

  test('a second first decision is refused naming the winner and its decider', () => {
    store.insertDecision(decision({ id: 'd1' }))
    const refused = conflict(() => store.insertDecision(decision({ id: 'd2', choice: 'B', decidedBy: human, commandId: 'cmd-1' })))
    expect(refused.kind).toBe('card-decided')
    expect(refused.decision!.id).toBe('d1')
    expect(refused.message).toContain('lead-1 (lead)')
    expect(store.decisionsOfCard('t', 'card-1')).toHaveLength(1)
  })

  test('a known human command id is refused carrying the recorded decision and payload', () => {
    store.insertDecision(decision({ id: 'd1', decidedBy: human, commandId: 'cmd-1', payload: { choice: 'A' } }))
    const refused = conflict(() => store.insertDecision(decision({ id: 'o1', seq: 2, kind: 'override', decidedBy: human, commandId: 'cmd-1' })))
    expect(refused.kind).toBe('command-replay')
    expect(refused.decision!.id).toBe('d1')
    expect(store.decisionByCommand('t', 'p', 'cmd-1')).toEqual({ decision: store.decision('t', 'd1')!, payload: { choice: 'A' } })
  })

  test('null agent command ids never collide', () => {
    store.insertCard(card({ id: 'card-2', messageId: 'msg-2' }))
    store.insertDecision(decision({ id: 'd1' }))
    store.insertDecision(decision({ id: 'd2', cardId: 'card-2' }))
    expect(store.decisionsOfPlan('t', 'p').map(found => found.id).sort()).toEqual(['d1', 'd2'])
  })

  test('the reply message is recorded after send', () => {
    store.insertDecision(decision({ id: 'd1' }))
    store.setReplyMessage('t', 'd1', 'msg-reply')
    expect(store.decision('t', 'd1')!.replyMessageId).toBe('msg-reply')
  })

  test("another team's decision reads as not found", () => {
    store.insertDecision(decision({ id: 'd1', decidedBy: human, commandId: 'cmd-1' }))
    expect(store.decision('other', 'd1')).toBeNull()
    expect(store.decisionsOfCard('other', 'card-1')).toEqual([])
    expect(store.decisionByCommand('other', 'p', 'cmd-1')).toBeNull()
  })
})

describe('fix tasks', () => {
  test('one task per override; a second is refused carrying the first', () => {
    store.insertFixTask({ taskId: 'task-fix', teamId: 't', planId: 'p', sourceKind: 'override', sourceId: 'o1' })
    const refused = conflict(() => store.insertFixTask({ taskId: 'task-fix-2', teamId: 't', planId: 'p', sourceKind: 'override', sourceId: 'o1' }))
    expect(refused.kind).toBe('fix-source-taken')
    expect(refused.fixTask!.taskId).toBe('task-fix')
    expect(store.fixTasksOfPlan('t', 'p').map(found => found.taskId)).toEqual(['task-fix'])
  })

  test('the same source id under another kind is a distinct source', () => {
    store.insertFixTask({ taskId: 'task-fix', teamId: 't', planId: 'p', sourceKind: 'override', sourceId: 'x' })
    store.insertFixTask({ taskId: 'task-corr', teamId: 't', planId: 'p', sourceKind: 'promotion', sourceId: 'x' })
    expect(store.fixTaskBySource('t', 'promotion', 'x')!.taskId).toBe('task-corr')
    expect(store.fixTasksOfTeam('t')).toHaveLength(2)
  })

  test('one correction task per promotion', () => {
    store.insertFixTask({ taskId: 'task-corr', teamId: 't', planId: 'p', sourceKind: 'promotion', sourceId: 'promo-1' })
    const refused = conflict(() => store.insertFixTask({ taskId: 'task-corr-2', teamId: 't', planId: 'p', sourceKind: 'promotion', sourceId: 'promo-1' }))
    expect(refused.kind).toBe('fix-source-taken')
    expect(refused.fixTask!.taskId).toBe('task-corr')
  })

  test("another team's fix task reads as not found", () => {
    store.insertFixTask({ taskId: 'task-fix', teamId: 't', planId: 'p', sourceKind: 'override', sourceId: 'o1' })
    expect(store.fixTask('other', 'task-fix')).toBeNull()
    expect(store.fixTaskBySource('other', 'override', 'o1')).toBeNull()
    expect(store.fixTasksOfPlan('other', 'p')).toEqual([])
  })
})
