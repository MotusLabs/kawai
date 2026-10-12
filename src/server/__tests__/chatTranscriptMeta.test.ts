// Unit tests for the single-pass transcript meta reader and the async
// transcript IO mirrors (async-transcript-parsing design D1): parity with the
// sync readers, tolerance of unreadable files, discovery of nested transcripts
// (newest wins), and replay parity.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  findTranscriptPathAsync,
  readTranscriptMeta,
  readTranscriptMetaAsync,
  readTranscriptCwd,
  readTranscriptTitle,
  replayTranscriptFile,
  replayTranscriptFileAsync,
} from '../chat/transcriptReplay'

let tempDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

function transcriptPath(sdkSessionId: string, projectDir = '-tmp-proj'): string {
  return path.join(tempDir, 'projects', projectDir, `${sdkSessionId}.jsonl`)
}

function writeTranscript(
  sdkSessionId: string,
  lines: string[],
  projectDir = '-tmp-proj'
): string {
  const dir = path.dirname(transcriptPath(sdkSessionId, projectDir))
  fs.mkdirSync(dir, { recursive: true })
  const filePath = transcriptPath(sdkSessionId, projectDir)
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`)
  return filePath
}

function userLine(uuid: string, cwd?: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-10-12T10:00:00.000Z',
    message: { role: 'user', content: 'hello' },
    ...(cwd !== undefined ? { cwd } : {}),
  })
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-transcript-meta-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterAll(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('readTranscriptMeta', () => {
  test('returns title and cwd from one pass, matching the sync readers', () => {
    const filePath = writeTranscript('sdk-meta-1', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'openspec-apply', sessionId: 'sdk-meta-1' }),
      userLine('u1', '/tmp/proj'),
      userLine('u2', '/tmp/proj/.claude/worktrees/add-feature'),
    ])

    const meta = readTranscriptMeta(filePath)

    expect(meta.title).toEqual({ title: 'openspec-apply', source: 'auto' })
    expect(meta.cwd).toBe('/tmp/proj/.claude/worktrees/add-feature')
    // Parity: the fields equal what the dedicated readers return.
    expect(meta.title).toEqual(readTranscriptTitle(filePath))
    expect(meta.cwd).toBe(readTranscriptCwd(filePath))
  })

  test('returns nulls when the transcript holds neither field', () => {
    const filePath = writeTranscript('sdk-meta-2', [userLine('u1')])

    const meta = readTranscriptMeta(filePath)

    expect(meta).toEqual({ title: null, cwd: null })
  })

  test('returns nulls for an unreadable file (sync and async)', async () => {
    const missing = transcriptPath('sdk-never-written')

    expect(readTranscriptMeta(missing)).toEqual({ title: null, cwd: null })
    expect(await readTranscriptMetaAsync(missing)).toEqual({ title: null, cwd: null })
  })

  test('async mirror matches the sync reader', async () => {
    const filePath = writeTranscript('sdk-meta-3', [
      JSON.stringify({ type: 'custom-title', customTitle: 'My pinned name', sessionId: 'sdk-meta-3' }),
      userLine('u1', '/tmp/other'),
    ])

    await expect(readTranscriptMetaAsync(filePath)).resolves.toEqual(
      readTranscriptMeta(filePath)
    )
  })
})

describe('findTranscriptPathAsync', () => {
  test('locates a nested transcript', async () => {
    writeTranscript('sdk-find-1', [userLine('u1')], '-encoded-project-dir')

    await expect(findTranscriptPathAsync('sdk-find-1')).resolves.toBe(
      transcriptPath('sdk-find-1', '-encoded-project-dir')
    )
  })

  test('prefers the newest duplicate across project dirs', async () => {
    const older = writeTranscript('sdk-find-2', [userLine('u1')], '-proj-a')
    const newer = writeTranscript('sdk-find-2', [userLine('u2')], '-proj-b')
    const atime = new Date()
    fs.utimesSync(older, atime, new Date('2026-01-01T00:00:00Z'))
    fs.utimesSync(newer, atime, new Date('2026-02-01T00:00:00Z'))

    await expect(findTranscriptPathAsync('sdk-find-2')).resolves.toBe(newer)
  })

  test('skips a candidate that disappears before stat and finds another copy', async () => {
    const missing = writeTranscript('sdk-find-race', [userLine('u1')], '-race-a')
    const remaining = writeTranscript('sdk-find-race', [userLine('u2')], '-race-b')
    const originalStat = fsp.stat.bind(fsp)
    const stat = spyOn(fsp, 'stat').mockImplementation(((file: string, ...args: unknown[]) => {
      if (String(file) === missing) return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      return originalStat(file, ...args as [])
    }) as typeof fsp.stat)
    try {
      await expect(findTranscriptPathAsync('sdk-find-race')).resolves.toBe(remaining)
    } finally { stat.mockRestore() }
  })

  test('resolves null for an unknown session', async () => {
    await expect(findTranscriptPathAsync('sdk-unknown')).resolves.toBeNull()
  })
})

describe('replayTranscriptFileAsync', () => {
  test('reports a missing transcript the same way as the sync reader', async () => {
    const sync = replayTranscriptFile(null)
    const asyncResult = await replayTranscriptFileAsync(null)

    expect(asyncResult).toEqual(sync)
    expect(asyncResult.status).toBe('missing')
  })

  test('parses a transcript identically to the sync reader', async () => {
    const filePath = writeTranscript('sdk-replay-1', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'a title', sessionId: 'sdk-replay-1' }),
      userLine('u1', '/tmp/proj'),
    ])

    await expect(replayTranscriptFileAsync(filePath)).resolves.toEqual(
      replayTranscriptFile(filePath)
    )
  })
})
