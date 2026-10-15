// The last-known-identity directory (team-message-threads D3): a session's
// name and group are upserted per team, repeated upserts overwrite rather than
// duplicate, and the rows survive closing and reopening the database — which
// is the point of the table, since it answers for sessions chat_sessions no
// longer holds.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionDirectory } from '../team/sessionDirectory'

const TEAM = '/repo/.git'
const OTHER = '/other/.git'

function open(): Database {
  return schemaDb(':memory:')
}

describe('SessionDirectory', () => {
  test('create upserts a session with its name and group', () => {
    const directory = new SessionDirectory(open())
    directory.upsert(TEAM, { sessionId: 'chat-1', name: 'Export button', group: 'devs' })
    expect(directory.get(TEAM, 'chat-1')).toEqual({
      sessionId: 'chat-1', name: 'Export button', group: 'devs',
    })
  })

  test('a session with no group records a null group', () => {
    const directory = new SessionDirectory(open())
    directory.upsert(TEAM, { sessionId: 'chat-1', name: 'Solo', group: null })
    expect(directory.get(TEAM, 'chat-1')).toEqual({ sessionId: 'chat-1', name: 'Solo', group: null })
  })

  test('repeated upserts overwrite the recorded name and group', () => {
    const directory = new SessionDirectory(open())
    const entry = { sessionId: 'chat-1', name: 'First', group: 'devs' }
    directory.upsert(TEAM, entry)
    directory.upsert(TEAM, { sessionId: 'chat-1', name: 'Second', group: 'qa' })
    directory.upsert(TEAM, { sessionId: 'chat-1', name: 'Third', group: null })
    expect(directory.get(TEAM, 'chat-1')).toEqual({ sessionId: 'chat-1', name: 'Third', group: null })
    expect(directory.list(TEAM)).toHaveLength(1)
  })

  test('entries are team scoped and listed oldest first', () => {
    const directory = new SessionDirectory(open())
    directory.upsert(TEAM, { sessionId: 'a', name: 'A', group: null }, '2026-01-01T00:00:00.000Z')
    directory.upsert(TEAM, { sessionId: 'b', name: 'B', group: 'devs' }, '2026-01-02T00:00:00.000Z')
    directory.upsert(OTHER, { sessionId: 'c', name: 'C', group: null }, '2026-01-03T00:00:00.000Z')
    expect(directory.list(TEAM).map(row => row.sessionId)).toEqual(['a', 'b'])
    expect(directory.list(OTHER).map(row => row.sessionId)).toEqual(['c'])
    expect(directory.get(TEAM, 'c')).toBeNull()
  })

  test('an unknown session reads as null', () => {
    const directory = new SessionDirectory(open())
    expect(directory.get(TEAM, 'never-seen')).toBeNull()
    expect(directory.list(TEAM)).toEqual([])
  })

  test('entries survive closing and reopening the database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-directory-'))
    const file = path.join(dir, 'mail.db')
    try {
      const db = schemaDb(file)
      new SessionDirectory(db).upsert(TEAM, { sessionId: 'chat-1', name: 'Kept', group: 'devs' })
      db.close()

      const reopened = new SessionDirectory(schemaDb(file))
      expect(reopened.get(TEAM, 'chat-1')).toEqual({ sessionId: 'chat-1', name: 'Kept', group: 'devs' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
