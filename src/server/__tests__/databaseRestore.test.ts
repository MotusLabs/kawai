// The restore procedure of docs/operations/database-backups.md (execution-
// safety-recovery D16), followed step by step on a copy in a temporary home:
// a build that knows version 2 migrates and writes more rows; an older build
// (knowing only version 1) refuses the file; the owner stops, moves the
// database and its journal aside together, copies the `pre-migration-2`
// backup in, checks integrity, and starts the older build, which opens at
// version 1 with the backup's rows and none written after it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { integrityCheck } from '../dbSafety/backups'
import { DatabaseStartupError, readSchemaVersion, type Migration } from '../dbSafety/migrations'

let home: string
let dbPath: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-restore-'))
  dbPath = path.join(home, '.agentboard', 'agentboard.db')
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

const migration2: Migration = { version: 2, name: 'example-table', up: db => db.exec('CREATE TABLE example_rows (id TEXT PRIMARY KEY)') }
const setting = (key: string) => (session: ReturnType<typeof initDatabase>) => session.setAppSetting(key, 'v')

test('restoring a pre-migration-2 backup starts an older build at version 1 with the backup rows', () => {
  // The older build runs first and writes a row.
  const older = initDatabase({ path: dbPath })
  setting('before-upgrade')(older)
  older.close()
  // The newer build migrates (taking pre-migration-2) and writes after the snapshot.
  const newer = initDatabase({ path: dbPath, migrations: [migration2] })
  setting('after-upgrade')(newer)
  newer.close()

  // Going back is refused while the newer file is in place.
  expect(() => initDatabase({ path: dbPath })).toThrow(DatabaseStartupError)

  // 1. The server is stopped (every connection above is closed).
  // 2. Move the database and any journal aside together.
  const aside = path.join(home, 'aside')
  fs.mkdirSync(aside)
  for (const name of ['agentboard.db', 'agentboard.db-journal']) {
    const from = path.join(home, '.agentboard', name)
    if (fs.existsSync(from)) fs.renameSync(from, path.join(aside, name))
  }
  // 3. Copy the chosen backup in.
  const backupsDir = path.join(home, '.agentboard', 'backups')
  const backup = fs.readdirSync(backupsDir).find(name => name.endsWith('-pre-migration-2.db'))!
  expect(backup).toBeDefined()
  fs.copyFileSync(path.join(backupsDir, backup), dbPath)
  // 4. Check integrity.
  expect(integrityCheck(dbPath)).toBeNull()
  // 5. Start the older build.
  const restored = initDatabase({ path: dbPath })
  expect(readSchemaVersion(restored.db)).toBe(1)
  expect(restored.getAppSetting('before-upgrade')).toBe('v')
  // Rows written after the snapshot are simply absent.
  expect(restored.getAppSetting('after-upgrade')).toBeNull()
  restored.close()
  // The newer file stays aside, untouched by the restore.
  expect(fs.existsSync(path.join(aside, 'agentboard.db'))).toBe(true)
})
