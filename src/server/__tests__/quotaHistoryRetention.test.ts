// Quota history retention (process-quota-history-and-incident-advice D3):
// quota observations are detail, so the foundation's retention pass prunes
// them with the 14-day interval rows, inside its bounded batch; recent rows
// stay. Frozen recommendation evidence outliving the prune is Table R row R9.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionDatabase } from '../db'
import { QuotaObservationStore } from '../metrics/observations/quotaObservations'
import { ObservationStore, PRUNE_BATCH } from '../metrics/observations/store'
import { freshTestDatabase } from './helpers/testDatabase'

const DAY = 24 * 3600_000
let root = ''
let db: SessionDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

test('the retention pass prunes quota observations recorded more than 14 days ago, in its batch, and keeps recent ones', () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-quota-retention-')))
  db = freshTestDatabase(path.join(root, 'test.db'))
  let now = Date.parse('2026-06-01T00:00:00.000Z')
  const quota = new QuotaObservationStore(db.db, () => now)
  const write = (count: number) => quota.record({
    teams: Array.from({ length: count }, (_, i) => `team-${i}`), providerId: 'zai', accountAlias: 'zai@zai.test', accountScope: 'scope',
    accountBasis: 'routed', reason: 'worker', outcome: 'failed', report: null, observedAt: new Date(now).toISOString(),
  })
  write(PRUNE_BATCH + 3)
  now += 13 * DAY
  write(2)
  now += 2 * DAY
  const store = new ObservationStore(db.db, () => now)
  const count = () => (db!.db.prepare('SELECT COUNT(*) AS n FROM process_quota_observations').get() as { n: number }).n
  expect(store.prune()).toBe(PRUNE_BATCH)
  expect(count()).toBe(5)
  expect(store.prune()).toBe(3)
  expect(count()).toBe(2)
  expect(store.prune()).toBe(0)
})
