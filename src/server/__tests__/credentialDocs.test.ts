// @reads: docs/claude-session-profiles.md
// The backup-honesty statement of provider-credential-store (S6, task 5.1):
// the operator documentation's "Credential store" section names every backup
// taken before the migration commit, advises rotation, and states when
// rotation ages them out — with figures that are the backup code's own
// retention, so a retention change that leaves the doc stale fails here.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { RETENTION } from '../dbSafety/backupFiles'
import { BACKUP_INTERVAL_MS } from '../dbSafety/backups'

const DOC = path.join(import.meta.dir, '..', '..', '..', 'docs', 'claude-session-profiles.md')

function section(title: string): string {
  const text = fs.readFileSync(DOC, 'utf8')
  const start = text.indexOf(`## ${title}\n`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ')
}

describe('credential store documentation', () => {
  // @covers: provider-credentials › Legacy Settings credentials migrate to the store at upgrade › Backups taken before the commit are named honestly
  test('the backup-honesty statement names pre-commit backups, advises rotation, and states the code\'s retention', () => {
    const doc = section('Credential store')
    expect(doc).toContain('Every backup taken before the migration\'s database commit can contain the map')
    expect(doc).toContain('the upgrade\'s own startup snapshot and every `pre-migration-<n>` backup')
    expect(doc).toContain('rotate the credentials')
    expect(BACKUP_INTERVAL_MS).toBe(60 * 60 * 1000)
    expect(doc).toContain(`${RETENTION.interval} hourly \`interval\` snapshots`)
    expect(doc).toContain(`${RETENTION.startup} \`startup\` snapshots`)
    expect(RETENTION.preMigrations).toBe(3)
    expect(doc).toContain('the `pre-migration-<n>` backups of the newest three migrations')
    expect(doc).toContain('No backup taken after the commit holds the map values.')
  })

  test('the section documents both kinds, the per-variable order, and the write-only routes', () => {
    const doc = section('Credential store')
    for (const phrase of [
      '`~/.kawai/credentials.json`', '(`launch-env`)', '(`secret-source`)',
      'the server process environment, `AGENTBOARD_CHAT_ENV`, then the store',
      'The map itself is never a source',
      'never a value, a prefix, or a length', 'The retired `/api/settings/chat-provider-env` answers 404.',
    ]) expect(doc).toContain(phrase)
  })
})
