// The context-exhausted flag columns (chat-context-exhaustion D3, migration 10):
// a fresh row reads as not flagged, updateChatSession round-trips the flag as
// one value over both columns, survives a reopen, and null clears both.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'

const FLAG = { at: '2026-10-18T08:28:01.000Z', reason: 'blocking_limit' }

test('the flag round-trips, survives a reopen, and clears with null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-exhausted-db-'))
  const dbPath = path.join(dir, 'test.db')
  try {
    let db = initDatabase({ path: dbPath })
    const now = new Date().toISOString()
    db.insertChatSession({
      sessionId: 'row', name: 'row', projectPath: '/tmp/proj', sdkSessionId: null,
      status: 'waiting', createdAt: now, lastActivityAt: now,
    })
    expect(db.getChatSession('row')?.contextExhausted).toBeNull()
    expect(db.updateChatSession('row', { contextExhausted: FLAG })?.contextExhausted).toEqual(FLAG)
    db.close()

    db = initDatabase({ path: dbPath })
    expect(db.getChatSession('row')?.contextExhausted).toEqual(FLAG)
    // An unrelated patch leaves it alone; null clears both columns together.
    db.updateChatSession('row', { name: 'renamed' })
    expect(db.getChatSession('row')?.contextExhausted).toEqual(FLAG)
    db.updateChatSession('row', { contextExhausted: null })
    expect(db.getChatSession('row')?.contextExhausted).toBeNull()
    const raw = db.db.prepare('SELECT context_exhausted_at, context_exhausted_reason FROM chat_sessions').get()
    expect(raw).toEqual({ context_exhausted_at: null, context_exhausted_reason: null })
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
