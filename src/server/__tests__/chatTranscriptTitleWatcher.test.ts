// Transcript title tail tests: the watcher reports the file's current title
// on arm, each appended title row as it lands, a truncated trailing line only
// once completed, and nothing after close(). A watch armed before the file
// exists picks the file up on creation through the directory fallback.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watchTranscriptTitle } from '../chat/transcriptTitleWatcher'

interface Observed {
  title: string
  source: 'auto' | 'manual'
}

/** Append a string to the file (the writer side of the tail). */
function append(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text)
}

/** Wait for fs.watch events to drain into the callback. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitForObserved(
  observed: Observed[],
  predicate: (entry: Observed) => boolean,
  timeoutMs = 2_000
): Promise<Observed[]> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate(observed[observed.length - 1] ?? ({} as Observed))) {
      return observed
    }
    await settle(2)
  }
  throw new Error(
    `Timed out waiting for title; observed: ${JSON.stringify(observed)}`
  )
}

function aiTitle(title: string): string {
  return `${JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 's' })}\n`
}

function customTitle(title: string): string {
  return `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's' })}\n`
}

describe('watchTranscriptTitle', () => {
  let tempDir: string

  const makeFile = (initialContent = ''): string => {
    const filePath = path.join(tempDir, 'transcript.jsonl')
    fs.writeFileSync(filePath, initialContent)
    return filePath
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-titlewatch-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('reports the current title on arm, then each appended one', async () => {
    const filePath = makeFile(aiTitle('first title'))
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    try {
      await waitForObserved(observed, (entry) => entry.title === 'first title')
      expect(observed[0]).toEqual({ title: 'first title', source: 'auto' })
      append(filePath, aiTitle('better title'))
      await waitForObserved(observed, (entry) => entry.title === 'better title')
      expect(observed[observed.length - 1]).toEqual({
        title: 'better title',
        source: 'auto',
      })
    } finally {
      watcher.close()
    }
  })

  test('a custom-title row reports manual source', async () => {
    const filePath = makeFile()
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    try {
      append(filePath, customTitle('user title'))
      await waitForObserved(observed, (entry) => entry.title === 'user title')
      expect(observed[observed.length - 1]).toEqual({
        title: 'user title',
        source: 'manual',
      })
    } finally {
      watcher.close()
    }
  })

  test('a truncated trailing line waits for the write that completes it', async () => {
    const filePath = makeFile()
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    try {
      // Half a row lands (no newline, no closing brace): nothing to report.
      append(filePath, '{"type":"ai-title","aiTitle":"trunc')
      await settle()
      expect(observed).toEqual([])
      // The rest of the row plus its newline completes it.
      append(filePath, 'ated title","sessionId":"s"}\n')
      await waitForObserved(observed, (entry) => entry.title === 'truncated title')
      expect(observed).toHaveLength(1)
    } finally {
      watcher.close()
    }
  })

  test('close() stops delivery', async () => {
    const filePath = makeFile()
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    watcher.close()
    append(filePath, aiTitle('after close'))
    await settle()
    expect(observed).toEqual([])
  })

  test('a watch armed before the file exists picks up its creation', async () => {
    const filePath = path.join(tempDir, 'late.jsonl')
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    try {
      await settle(2)
      fs.writeFileSync(filePath, aiTitle('late title'))
      await waitForObserved(observed, (entry) => entry.title === 'late title')
      // And it keeps tailing afterwards.
      append(filePath, aiTitle('late title two'))
      await waitForObserved(observed, (entry) => entry.title === 'late title two')
    } finally {
      watcher.close()
    }
  })

  test('a rewritten (shrunk) file is re-read from the start', async () => {
    const filePath = makeFile(aiTitle('long first title that will be replaced'))
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    try {
      await waitForObserved(observed, (entry) => entry.title.startsWith('long first'))
      // Compaction-style rewrite: the new file is shorter than the offset.
      fs.writeFileSync(filePath, aiTitle('short'))
      await waitForObserved(observed, (entry) => entry.title === 'short')
    } finally {
      watcher.close()
    }
  })

  test('an atomic replacement (temp file + rename) is followed, equal size included', async () => {
    // Same byte length, so a size-only check cannot distinguish the files:
    // the replacement must be caught by identity, not size.
    const filePath = makeFile(aiTitle('replaced-title-one'))
    const observed: Observed[] = []
    const watcher = watchTranscriptTitle(filePath, (title, source) =>
      observed.push({ title, source })
    )
    try {
      await waitForObserved(observed, (entry) => entry.title === 'replaced-title-one')
      expect(
        Buffer.byteLength(aiTitle('replaced-title-one'))
      ).toBe(Buffer.byteLength(aiTitle('replaced-title-two')))
      const temp = path.join(tempDir, 'transcript.jsonl.tmp')
      fs.writeFileSync(temp, aiTitle('replaced-title-two'))
      fs.renameSync(temp, filePath)
      await waitForObserved(observed, (entry) => entry.title === 'replaced-title-two')
      // The new inode is the one being tailed now: a later append to it lands.
      append(filePath, aiTitle('appended after replace'))
      await waitForObserved(observed, (entry) => entry.title === 'appended after replace')
      expect(observed.map((entry) => entry.title)).toEqual([
        'replaced-title-one',
        'replaced-title-two',
        'appended after replace',
      ])
    } finally {
      watcher.close()
    }
  })
})
