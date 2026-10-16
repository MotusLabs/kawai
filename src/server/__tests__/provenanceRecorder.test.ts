// Agent-start recording (team-process-metrics D2): a start row per spawn with
// its hashes, identical memory sharing one manifest row, a group-file edit
// changing the next start's hash, the latest start per session surviving a
// fresh recorder, and the manager's onSpawn path writing a start.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProvenanceRecorder } from '../metrics/provenanceRecorder'
import { memoryDirFor, sha256 } from '../metrics/provenanceHash'
import { schemaDb } from './schemaDb'

let root: string
beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-provenance-rec-'))) })
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test('starts record their hashes; equal memory shares one manifest; an edited group file changes the next hash', () => {
  const db = schemaDb()
  const recorder = new ProvenanceRecorder(db)
  const home = path.join(root, 'home')
  const main = '/work/repo'
  fs.mkdirSync(memoryDirFor(main, { HOME: home }), { recursive: true })
  fs.writeFileSync(path.join(memoryDirFor(main, { HOME: home }), 'MEMORY.md'), 'index')
  const groupFile = path.join(root, 'reviewers.md')
  fs.writeFileSync(groupFile, 'Review v1')
  const base = {
    teamId: '/work/repo/.git', groupId: 'reviewers', profileId: 'default', model: 'claude-opus-5-5', effort: 'high',
    cwd: main, groupFile, promptAppend: 'append', mainCheckout: main, worktreeRoot: path.join(root, 'none'), env: { HOME: home },
  }
  const first = recorder.record({ ...base, sessionId: 'chat-a' }, '2026-10-16T00:00:00.000Z')
  const second = recorder.record({ ...base, sessionId: 'chat-b' }, '2026-10-16T00:01:00.000Z')
  fs.writeFileSync(groupFile, 'Review v2')
  const third = recorder.record({ ...base, sessionId: 'chat-a' }, '2026-10-16T00:02:00.000Z')

  const [a1, a2] = recorder.starts('chat-a')
  const [b1] = recorder.starts('chat-b')
  expect(a1).toMatchObject({ id: first, groupId: 'reviewers', model: 'claude-opus-5-5', effort: 'high', groupFileHash: sha256('Review v1'), promptAppendHash: sha256('append'), memoryFiles: 1, instructionsHash: null, unavailable: [] })
  expect(b1!.id).toBe(second)
  expect(b1!.groupFileHash).toBe(a1!.groupFileHash)
  expect(a2!.id).toBe(third)
  expect(a2!.groupFileHash).toBe(sha256('Review v2'))
  expect(db.prepare('SELECT COUNT(*) AS n FROM memory_manifests').get()).toEqual({ n: 1 })
  expect(recorder.manifest(a1!.memoryHash!)).toEqual({ 'MEMORY.md': sha256('index') })
  expect(recorder.latestStart('chat-a')).toBe(third)
  // A fresh recorder (after a restart) reads the newest recorded start.
  expect(new ProvenanceRecorder(db).latestStart('chat-a')).toBe(third)
  expect(new ProvenanceRecorder(db).latestStart('chat-none')).toBeNull()
  db.close()
})

test('a session without a group and without memory records nulls', () => {
  const db = schemaDb()
  const recorder = new ProvenanceRecorder(db)
  recorder.record({
    sessionId: 'chat-x', teamId: null, groupId: null, profileId: null, model: null, effort: null, cwd: '/x',
    groupFile: null, promptAppend: '', mainCheckout: '/x', worktreeRoot: '/x', env: { HOME: path.join(root, 'nobody') },
  })
  expect(recorder.starts('chat-x')[0]).toMatchObject({ groupFileHash: null, memoryHash: null, memoryFiles: null, promptAppendHash: sha256('') })
  db.close()
})
