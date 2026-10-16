// The validation store (plan-validation design D1): append-only rows, `seq`
// numbering per revision, command-id uniqueness at the database, and nothing
// but inserts — there is no update path.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ValidationStore, ValidationCommandRaceError } from '../plans/validation/validationStore'
import type { NewValidationReport } from '../plans/validation/validationStore'
import { schemaDb } from './schemaDb'
import { VALIDATION_CHECKS_VERSION, type ValidationInputs } from '../../shared/planValidation'

const inputs = (planId: string, revision: number, contentHash = 'hash'): ValidationInputs => ({
  checksVersion: VALIDATION_CHECKS_VERSION,
  plan: { planId, revision, contentHash },
  impactStateKey: 'impact',
  adapter: { tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json'] },
  changes: [],
  catalog: { groups: {}, profiles: 'p' },
  claims: { branch: [], changes: {} },
  records: { assessments: [], decisions: [] },
})

const report = (planId: string, revision: number, inputHash: string): NewValidationReport => ({
  planId, revision, inputHash, inputs: inputs(planId, revision, inputHash),
  findings: [], relations: [], evidence: { changes: {}, branch: null, capacity: [] },
  readiness: { ready: false, errors: [], unansweredQuestions: [], unacceptedWarnings: [], alignment: { state: 'unassessed', reason: null, effective: null }, carriedConditions: [] },
  ready: false, requestedBy: { kind: 'human', sessionId: null },
})

describe('ValidationStore reports', () => {
  test('numbers reports per revision from 1 and keeps the newest by max seq', () => {
    const store = new ValidationStore(schemaDb())
    const first = store.insertReport(report('plan-1', 2, 'h1'))
    const second = store.insertReport(report('plan-1', 2, 'h2'))
    const otherRevision = store.insertReport(report('plan-1', 3, 'h1'))
    expect([first.seq, second.seq, otherRevision.seq]).toEqual([1, 2, 1])
    expect(store.newestReport('plan-1', 2)!.inputHash).toBe('h2')
    expect(store.reports('plan-1', 2).map(row => row.seq)).toEqual([1, 2])
  })

  test('UNIQUE (plan_id, revision, seq) refuses a duplicate seq at the database', () => {
    const db = schemaDb()
    const store = new ValidationStore(db)
    store.insertReport(report('plan-1', 1, 'h1'))
    // Hand-insert a second row with the same (plan, revision, seq): the store
    // computes max+1 so this can only happen by racing another writer.
    expect(() => db.prepare(`INSERT INTO plan_validation_reports
      (id, plan_id, revision, seq, input_hash, inputs_json, findings_json, relations_json, evidence_json, readiness_json, ready, requested_kind, requested_session, created_at)
      VALUES ('pvr-x', 'plan-1', 1, 1, 'h2', '{}', '[]', '[]', '{}', '{}', 0, 'human', NULL, '2026-01-01T00:00:00Z')`).run()).toThrow(/UNIQUE/)
  })

  test('a stored report round-trips every field', () => {
    const store = new ValidationStore(schemaDb())
    const inserted = store.insertReport({
      ...report('plan-1', 1, 'h1'),
      findings: [{ check: 'relations', key: 'relations:conflict:a+b:c/R', severity: 'error', row: 'scope', subject: 'a+b:c', message: 'conflict' }],
      relations: [{ kind: 'conflict', changes: ['a', 'b'], capability: 'c', requirements: ['R'], order: null }],
      evidence: { changes: { a: { root: '/repo', dir: '/repo/openspec/changes/a', head: 'deadbee', issues: [{ level: 'error', message: 'bad' }] } }, branch: { exists: true, head: 'abc', worktree: '/repo/.worktrees/x' }, capacity: [{ group: 'middle-devs', max: 2, live: 1, profiles: [{ profile: 'default', cap: 2, live: 1 }], cooling: [] }] },
      readiness: { ready: false, errors: ['relations:conflict:a+b:c/R'], unansweredQuestions: ['pas-1'], unacceptedWarnings: [], alignment: { state: 'blocked', reason: 'not assessed', effective: null }, carriedConditions: [] },
      requestedBy: { kind: 'agent', sessionId: 'chat-9' },
    }, '2026-01-01T00:00:00Z')
    const read = store.newestReport('plan-1', 1)!
    expect(read).toEqual({ ...inserted, dryRun: false })
    expect(read.requestedBy).toEqual({ kind: 'agent', sessionId: 'chat-9' })
    expect(read.evidence.changes.a!.issues).toEqual([{ level: 'error', message: 'bad' }])
  })

  test('a reopened store reads everything back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-plan-validation-store-'))
    try {
      const file = path.join(dir, 'test.db')
      const store = new ValidationStore(schemaDb(file))
      store.insertReport(report('plan-1', 1, 'h1'))
      store.insertAssessment({ planId: 'plan-1', revision: 1, kind: 'question', payload: { text: 'q', mandatory: true, subject: null }, author: { kind: 'agent', sessionId: 'chat-1' }, commandId: null })
      store.insertDecision({ planId: 'plan-1', revision: 1, kind: 'answer', target: 'pas-x', text: 'yes', scope: null, commandId: 'cmd-1', payload: { a: 1 } })

      const reopened = new ValidationStore(schemaDb(file))
      expect(reopened.reports('plan-1', 1)).toHaveLength(1)
      expect(reopened.assessments('plan-1', 1)).toHaveLength(1)
      expect(reopened.decisions('plan-1', 1)).toHaveLength(1)
      expect(reopened.decisionByCommand('plan-1', 'cmd-1')!.payload).toEqual({ a: 1 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ValidationStore assessments and decisions', () => {
  test('two agent rows with a null command id are both accepted', () => {
    const store = new ValidationStore(schemaDb())
    const agent = { kind: 'agent' as const, sessionId: 'chat-1' }
    store.insertAssessment({ planId: 'plan-1', revision: 1, kind: 'question', payload: { text: 'a', mandatory: true, subject: null }, author: agent, commandId: null })
    store.insertAssessment({ planId: 'plan-1', revision: 1, kind: 'question', payload: { text: 'b', mandatory: false, subject: null }, author: agent, commandId: null })
    expect(store.assessments('plan-1', 1)).toHaveLength(2)
    // The form's command id is unique per plan: a resend raises the race.
    store.insertAssessment({ planId: 'plan-1', revision: 1, kind: 'alignment', payload: { assessment: 'aligned' }, author: { kind: 'human', sessionId: null }, commandId: 'cmd-9' })
    expect(() => store.insertAssessment({ planId: 'plan-1', revision: 1, kind: 'alignment', payload: { assessment: 'aligned' }, author: { kind: 'human', sessionId: null }, commandId: 'cmd-9' })).toThrow(ValidationCommandRaceError)
    expect(store.assessments('plan-1', 1)).toHaveLength(3)
  })

  test('a decision command id is unique per plan and raises the race on reuse', () => {
    const store = new ValidationStore(schemaDb())
    store.insertDecision({ planId: 'plan-1', revision: 1, kind: 'answer', target: 'pas-1', text: 'yes', scope: null, commandId: 'cmd-1', payload: {} })
    expect(() => store.insertDecision({ planId: 'plan-1', revision: 2, kind: 'answer', target: 'pas-2', text: 'no', scope: null, commandId: 'cmd-1', payload: {} })).toThrow(ValidationCommandRaceError)
    expect(store.decisions('plan-1', 1)).toHaveLength(1)
    // The same command id on another plan is a different key.
    store.insertDecision({ planId: 'plan-2', revision: 1, kind: 'answer', target: 'pas-1', text: 'yes', scope: null, commandId: 'cmd-1', payload: {} })
    expect(store.decisions('plan-2', 1)).toHaveLength(1)
  })

  test('there is no update path: rows keep their first values', () => {
    const db = schemaDb()
    const store = new ValidationStore(db)
    store.insertDecision({ planId: 'plan-1', revision: 1, kind: 'answer', target: 'pas-1', text: 'first', scope: null, commandId: 'cmd-1', payload: {} })
    expect(db.prepare("SELECT COUNT(*) AS n FROM plan_validation_decisions WHERE text = 'first'").get()).toEqual({ n: 1 })
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(method => method.startsWith('update') || method.startsWith('delete'))).toEqual([])
  })
})
