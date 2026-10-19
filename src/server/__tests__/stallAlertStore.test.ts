// Stall-alert store (plan-supervision 3.3): one alert per episode, a
// repeated insert returns the stored row, a null message id is accepted,
// and reads are team-scoped.
import { beforeEach, expect, test } from 'bun:test'
import { StallAlertStore, type NewStallAlert } from '../plans/supervision/stallAlertStore'
import { schemaDb } from './schemaDb'

let clock = 0
let store: StallAlertStore
beforeEach(() => {
  clock = Date.parse('2026-10-19T00:00:00.000Z')
  store = new StallAlertStore(schemaDb(), () => new Date(clock))
})

const alert = (extra: Partial<NewStallAlert> = {}): NewStallAlert => ({
  teamId: 't', planId: 'p', executionId: 'e', change: 'api', kind: 'no-progress', episodeKey: '2026-10-18T22:00:00.000Z',
  detail: { deadlineAt: '2026-10-19T00:00:00.000Z' }, messageId: 'msg-1', ...extra,
})

test('an episode records one alert; a second insert returns the stored row', () => {
  const first = store.insert(alert())
  expect(first.inserted).toBe(true)
  clock += 60_000
  const second = store.insert(alert({ messageId: 'msg-2', detail: { other: true } }))
  expect(second).toEqual({ inserted: false, alert: first.alert })
  expect(store.ofPlan('t', 'p')).toHaveLength(1)
})

test('a new episode key, kind, or change is a new alert', () => {
  store.insert(alert())
  expect(store.insert(alert({ episodeKey: 'later' })).inserted).toBe(true)
  expect(store.insert(alert({ kind: 'repeating-failure' })).inserted).toBe(true)
  expect(store.insert(alert({ change: 'ui' })).inserted).toBe(true)
  expect(store.ofPlan('t', 'p')).toHaveLength(4)
})

test('a null message id (no Lead role) is accepted', () => {
  const { inserted, alert: stored } = store.insert(alert({ messageId: null }))
  expect(inserted).toBe(true)
  expect(stored.messageId).toBeNull()
  expect(store.episode('t', 'e', 'api', 'no-progress', '2026-10-18T22:00:00.000Z')).toEqual(stored)
})

test("reads are team-scoped and raisedSince bounds by time", () => {
  store.insert(alert())
  clock += 3_600_000
  store.insert(alert({ episodeKey: 'later' }))
  expect(store.ofPlan('other', 'p')).toEqual([])
  expect(store.episode('other', 'e', 'api', 'no-progress', '2026-10-18T22:00:00.000Z')).toBeNull()
  expect(store.raisedSince('t', '2026-10-19T00:30:00.000Z').map(found => found.episodeKey)).toEqual(['later'])
  expect(store.raisedSince('other', '2026-10-18T00:00:00.000Z')).toEqual([])
})
