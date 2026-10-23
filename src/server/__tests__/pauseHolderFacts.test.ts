// Direct unit tests for `pauseHolderFacts` (revision-control 4.3, D8): the
// killed, archived, and live holder states, cooling winning over parked
// resumes, the latest resume winning, and the busy causes. The composition
// test stubs these reads; these pin the choice itself.
import { describe, expect, test } from 'bun:test'
import type { ChatSessionRecord } from '../db'
import { pauseHolderFacts, type PauseHolderFactsDeps } from '../plans/revisionControl/pauseTick'
import { sessionRow } from './planHarness'

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString()

const deps = (record: ChatSessionRecord | undefined, over: Partial<PauseHolderFactsDeps> = {}): PauseHolderFactsDeps => ({
  getRecord: () => record,
  pendingRequest: () => false,
  hasLiveWorkers: () => false,
  hasRunningBackgroundTasks: () => false,
  parkedResumes: () => [],
  cooldownUntil: () => null,
  ...over,
})

describe('pauseHolderFacts (D8)', () => {
  test('a missing record is a killed holder: no request, not busy, no limit', () => {
    const facts = pauseHolderFacts(deps(undefined))('dev')
    expect(facts).toEqual({ state: 'killed', pendingRequest: false, busy: false, providerLimit: null })
  })

  test('an archived holder stays archived, its request and busy facts still read', () => {
    const record = { ...sessionRow('dev', null, '/p'), archivedAt: at(0) }
    const facts = pauseHolderFacts(deps(record, {
      pendingRequest: () => true,
      hasRunningBackgroundTasks: () => true,
    }))('dev')
    expect(facts.state).toBe('archived')
    expect(facts.pendingRequest).toBe(true)
    expect(facts.busy).toBe(true)
    expect(facts.providerLimit).toBeNull()
  })

  test('cooling wins over parked resumes (D6)', () => {
    const record = sessionRow('dev', null, '/p')
    const facts = pauseHolderFacts(deps(record, {
      cooldownUntil: () => at(30),
      parkedResumes: () => [at(10)],
    }))('dev')
    expect(facts.state).toBe('live')
    expect(facts.providerLimit).toEqual({ profile: 'default', resetAt: at(30) })
  })

  test('a parked holder reads its latest resume under its own profile', () => {
    const record = { ...sessionRow('dev', 'middle-devs', '/p'), claudeProfileId: 'glm' }
    const facts = pauseHolderFacts(deps(record, { parkedResumes: () => [at(20), null, at(5)] }))('dev')
    expect(facts.providerLimit).toEqual({ profile: 'glm', resetAt: at(20) })
  })

  test('neither cooling nor parked reads no limit', () => {
    const record = { ...sessionRow('dev', null, '/p'), claudeProfileId: 'glm' }
    const facts = pauseHolderFacts(deps(record, { parkedResumes: () => [null] }))('dev')
    expect(facts.state).toBe('live')
    expect(facts.providerLimit).toBeNull()
  })

  test('busy is a working status, a live worker, or a running background task', () => {
    const working = pauseHolderFacts(deps({ ...sessionRow('dev', null, '/p'), status: 'working' }))('dev')
    expect(working.busy).toBe(true)
    const worker = pauseHolderFacts(deps(sessionRow('dev', null, '/p'), { hasLiveWorkers: () => true }))('dev')
    expect(worker.busy).toBe(true)
    const tasks = pauseHolderFacts(deps(sessionRow('dev', null, '/p'), { hasRunningBackgroundTasks: () => true }))('dev')
    expect(tasks.busy).toBe(true)
    const idle = pauseHolderFacts(deps(sessionRow('dev', null, '/p')))('dev')
    expect(idle.busy).toBe(false)
  })
})
