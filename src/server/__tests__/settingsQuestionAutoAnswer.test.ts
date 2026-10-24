// Question auto-answer setting (openspec question-auto-answer, task 3.1):
// the app_settings key's boot read and GET/PUT route. The design's oracles
// QA-S1–QA-S4 name the value partition each test pins.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerMessage } from '../../shared/types'
import { initDatabase, type SessionDatabase } from '../db'
import { createSettingsRoutes, loadStoredSettings } from '../routes/settings'
import type { SessionManager } from '../SessionManager'
import type { SessionRefreshLoop } from '../refresh/SessionRefreshLoop'

interface Rig {
  db: SessionDatabase
  dbPath: string
  broadcast: ServerMessage[]
  holder: { get: () => number; set: (minutes: number) => void }
  routes: ReturnType<typeof createSettingsRoutes>
}

function createRig(): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaa-settings-'))
  const dbPath = path.join(dir, 'test.db')
  const db = initDatabase({ path: dbPath })
  const broadcast: ServerMessage[] = []
  let runtime = loadStoredSettings(db).questionAutoAnswerMinutes
  const holder = {
    get: () => runtime,
    set: (minutes: number) => {
      runtime = minutes
    },
  }
  const routes = createSettingsRoutes({
    db,
    sessionManager: {} as SessionManager,
    refresh: {} as SessionRefreshLoop,
    broadcast: (message) => broadcast.push(message),
    historyMaxAgeHours: { get: () => 24, set: () => {} },
    questionAutoAnswerMinutes: holder,
  })
  return { db, dbPath, broadcast, holder, routes }
}

/** PUT one minutes value; the body's JSON result comes back with it. */
const put = async (routes: Rig['routes'], minutes: unknown): Promise<{ status: number; body: { minutes?: number; error?: string } }> => {
  const response = await routes.request('/question-auto-answer', {
    method: 'PUT',
    body: JSON.stringify({ minutes }),
    headers: { 'content-type': 'application/json' },
  })
  return { status: response.status, body: await response.json() as { minutes?: number; error?: string } }
}

const getMinutes = async (routes: Rig['routes']): Promise<{ minutes: number }> =>
  await (await routes.request('/question-auto-answer')).json() as { minutes: number }

test('a never-saved key reads as the 5-minute default (QA-S1)', async () => {
  const rig = createRig()
  try {
    expect(await getMinutes(rig.routes)).toEqual({ minutes: 5 })
    expect(loadStoredSettings(rig.db).questionAutoAnswerMinutes).toBe(5)
  } finally {
    rig.db.close()
  }
})

test('a saved wait persists, applies to the runtime, and broadcasts (QA-S3)', async () => {
  const rig = createRig()
  try {
    const { status, body } = await put(rig.routes, 7)
    expect(status).toBe(200)
    expect(body).toEqual({ minutes: 7 })
    expect(rig.db.getAppSetting('question_auto_answer_minutes')).toBe('7')
    expect(rig.holder.get()).toBe(7)
    expect(rig.broadcast).toEqual([{ type: 'question-auto-answer-changed', minutes: 7 }])
    expect(await getMinutes(rig.routes)).toEqual({ minutes: 7 })
  } finally {
    rig.db.close()
  }
})

test('zero is saved and disables automatic answers (QA-S2)', async () => {
  const rig = createRig()
  try {
    const { status } = await put(rig.routes, 0)
    expect(status).toBe(200)
    expect(rig.db.getAppSetting('question_auto_answer_minutes')).toBe('0')
    expect(rig.holder.get()).toBe(0)
  } finally {
    rig.db.close()
  }
})

test('a saved wait is read back at boot (QA-S3 restart read)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaa-settings-'))
  const dbPath = path.join(dir, 'test.db')
  const db = initDatabase({ path: dbPath })
  let runtime = loadStoredSettings(db).questionAutoAnswerMinutes
  const routes = createSettingsRoutes({
    db,
    sessionManager: {} as SessionManager,
    refresh: {} as SessionRefreshLoop,
    broadcast: () => {},
    historyMaxAgeHours: { get: () => 24, set: () => {} },
    questionAutoAnswerMinutes: { get: () => runtime, set: (m) => { runtime = m } },
  })
  expect((await put(routes, 90)).status).toBe(200)
  db.close()

  const reopened = initDatabase({ path: dbPath })
  try {
    expect(loadStoredSettings(reopened).questionAutoAnswerMinutes).toBe(90)
  } finally {
    reopened.close()
  }
})

test('out-of-range and non-integer values are refused; nothing is stored or applied (QA-S4)', async () => {
  const rig = createRig()
  try {
    for (const minutes of [1441, -1, 2.5, 1442, 1.5, '5', null, undefined]) {
      const { status, body } = await put(rig.routes, minutes)
      expect(status).toBe(400)
      expect(body.error).toContain('whole number')
    }
    expect(rig.db.getAppSetting('question_auto_answer_minutes')).toBeNull()
    expect(rig.holder.get()).toBe(5)
    expect(rig.broadcast).toEqual([])
  } finally {
    rig.db.close()
  }
})

test('a stored value that fails validation reads as the default at boot', () => {
  const rig = createRig()
  try {
    rig.db.setAppSetting('question_auto_answer_minutes', 'not-a-number')
    expect(loadStoredSettings(rig.db).questionAutoAnswerMinutes).toBe(5)
    rig.db.setAppSetting('question_auto_answer_minutes', '99999')
    expect(loadStoredSettings(rig.db).questionAutoAnswerMinutes).toBe(5)
  } finally {
    rig.db.close()
  }
})

test('a failed persist applies nothing to the runtime (persist-then-apply)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaa-settings-'))
  const db = {
    getAppSetting: () => null,
    setAppSetting: () => {
      throw new Error('disk full')
    },
  } as unknown as SessionDatabase
  const broadcast: ServerMessage[] = []
  let runtime = 5
  const routes = createSettingsRoutes({
    db,
    sessionManager: {} as SessionManager,
    refresh: {} as SessionRefreshLoop,
    broadcast: (message) => broadcast.push(message),
    historyMaxAgeHours: { get: () => 24, set: () => {} },
    questionAutoAnswerMinutes: { get: () => runtime, set: (m) => { runtime = m } },
  })
  const response = await routes.request('/question-auto-answer', {
    method: 'PUT',
    body: JSON.stringify({ minutes: 30 }),
    headers: { 'content-type': 'application/json' },
  })
  expect(response.status).toBe(500)
  expect(runtime).toBe(5)
  expect(broadcast).toEqual([])
})
