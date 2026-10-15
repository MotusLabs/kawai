// The restore procedure of docs/operations/database-backups.md (execution-
// safety-recovery D16), followed exactly as written: the `sh` blocks of its
// "Restoring a backup" section run verbatim under `sh -e` with HOME set to a
// temporary home, so `~/.agentboard` is the test's own data directory. Only
// the example backup name is swapped for the real one. A build that knows
// version 2 migrates and writes more rows; an older build (knowing only
// version 1) refuses the file; the owner stops it, moves the database and its
// journal aside, copies the `pre-migration-2` backup in, checks integrity, and
// starts the older build, which opens at version 1 with the backup's rows and
// none written after it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { DatabaseStartupError, readSchemaVersion, type Migration } from '../dbSafety/migrations'

const DOC = path.join(import.meta.dir, '../../../docs/operations/database-backups.md')
const EXAMPLE_BACKUP = 'agentboard-20261016T080000000Z-pre-migration-2.db'

/** The doc's restore section as its three `sh` blocks: move aside, copy in, check. */
function restoreSteps(): { moveAside: string; copyIn: string; check: string[] } {
  const doc = fs.readFileSync(DOC, 'utf8')
  const section = doc.slice(doc.indexOf('## Restoring a backup'))
  const body = section.slice(0, section.indexOf('\n## ', 1))
  const blocks = [...body.matchAll(/```sh\n([\s\S]*?)```/g)].map(match =>
    match[1]!.split('\n').map(line => line.trim()).filter(Boolean))
  expect(blocks.length).toBe(3)
  return { moveAside: blocks[0]!.join('\n'), copyIn: blocks[1]!.join('\n'), check: blocks[2]! }
}

let home: string
let dataDir: string
let dbPath: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-restore-'))
  dataDir = path.join(home, '.agentboard')
  dbPath = path.join(dataDir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

function sh(script: string): { exit: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(['sh', '-e', '-c', script], {
    cwd: home,
    env: { HOME: home, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  })
  return { exit: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

const migration2: Migration = { version: 2, name: 'example-table', up: db => db.exec('CREATE TABLE example_rows (id TEXT PRIMARY KEY)') }

/** An older build writes, a newer one migrates and writes after its snapshot; going back is refused. */
function upgradeThenRefuse(): void {
  const older = initDatabase({ path: dbPath })
  older.setAppSetting('before-upgrade', 'v')
  older.close()
  const newer = initDatabase({ path: dbPath, migrations: [migration2] })
  newer.setAppSetting('after-upgrade', 'v')
  newer.close()
  expect(() => initDatabase({ path: dbPath })).toThrow(DatabaseStartupError)
}

describe('restoring a pre-migration-2 backup by the doc', () => {
  for (const journal of [true, false]) {
    test(`starts an older build at version 1 with the backup rows (${journal ? 'a journal left beside it' : 'no journal'})`, () => {
      const steps = restoreSteps()
      upgradeThenRefuse()
      // 1. The server is stopped: every connection above is closed. A crash
      // would have left a journal; its bytes stand in for one here.
      if (journal) fs.writeFileSync(`${dbPath}-journal`, 'leftover journal')

      // 2. Move the database and any journal aside together.
      expect(sh(steps.moveAside)).toMatchObject({ exit: 0, stderr: '' })
      const aside = path.join(home, 'agentboard-aside')
      expect(fs.readdirSync(aside).sort()).toEqual(journal ? ['agentboard.db', 'agentboard.db-journal'] : ['agentboard.db'])
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(fs.existsSync(`${dbPath}-journal`)).toBe(false)

      // 3. Copy the chosen backup in (the doc's example name, swapped for the real one).
      const backup = fs.readdirSync(path.join(dataDir, 'backups')).find(name => name.endsWith('-pre-migration-2.db'))!
      expect(backup).toBeDefined()
      expect(steps.copyIn).toContain(EXAMPLE_BACKUP)
      expect(sh(steps.copyIn.replace(EXAMPLE_BACKUP, backup))).toMatchObject({ exit: 0, stderr: '' })
      expect(fs.existsSync(path.join(dataDir, 'backups', backup))).toBe(true)

      // 4. Check integrity: each command reports `ok` and nothing else (sqlite3 only where installed).
      const [sqlite3, bun] = steps.check
      expect(sqlite3).toStartWith('sqlite3 ')
      expect(bun).toStartWith('bun ')
      expect(sh(bun!)).toEqual({ exit: 0, stdout: 'ok\n', stderr: '' })
      if (Bun.which('sqlite3')) expect(sh(sqlite3!)).toEqual({ exit: 0, stdout: 'ok\n', stderr: '' })

      // 5. Start the older build.
      const restored = initDatabase({ path: dbPath })
      expect(readSchemaVersion(restored.db)).toBe(1)
      expect(restored.getAppSetting('before-upgrade')).toBe('v')
      expect(restored.getAppSetting('after-upgrade')).toBeNull()
      expect(restored.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'example_rows'").get()).toBeNull()
      restored.close()
      // The newer file stays aside, untouched by the restore.
      expect(fs.existsSync(path.join(aside, 'agentboard.db'))).toBe(true)
    })
  }
})
