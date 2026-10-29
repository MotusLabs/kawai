// The streaming boot meta reader (`scanTranscriptMeta`, bounded-boot-restore
// D2), as the design's Tables T and C plus property P1: for any transcript
// it answers exactly the full parse's `title` and `cwd` — title precedence,
// the newest cwd from a valid non-meta non-sidechain record, marker text
// inside message bodies, lines straddling the 1 MiB read chunk, a torn tail
// — and nulls for an unreadable file.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanTranscriptMeta } from '../chat/transcriptMeta'
import { parseTranscriptContent, type TranscriptMeta } from '../chat/transcriptReplay'

let dir: string
let fileCount = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-meta-scan-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(content: string): string {
  fileCount += 1
  const file = path.join(dir, `t${fileCount}.jsonl`)
  fs.writeFileSync(file, content)
  return file
}

/** Scans `content`, asserts parity with the full parse, returns the scan. */
async function scanWithParity(content: string): Promise<TranscriptMeta> {
  const parsed = parseTranscriptContent(content)
  const scanned = await scanTranscriptMeta(write(content))
  expect(scanned).toEqual({ title: parsed.title, cwd: parsed.cwd })
  return scanned
}

const user = (cwd?: string, extra: Record<string, unknown> = {}, text = 'hello') =>
  JSON.stringify({
    type: 'user', uuid: crypto.randomUUID(), timestamp: '2026-10-12T10:00:00.000Z',
    message: { role: 'user', content: text }, ...(cwd ? { cwd } : {}), ...extra,
  })
const aiTitle = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title })
const customTitle = (title: string) => JSON.stringify({ type: 'custom-title', customTitle: title })
const attachment = (workingDirectory: string) =>
  JSON.stringify({ type: 'attachment', attachment: { snapshot: { workingDirectory } } })
const MARKER_BODY = 'the rows are "ai-title" and "custom-title"; "cwd" and "workingDirectory" too'
const MIB = 1 << 20

/** A first line padded so the next line starts `before` bytes ahead of 1 MiB. */
function padTo(before: number): string {
  const bare = Buffer.byteLength(user('/pad', {}, '')) + 1
  return user('/pad', {}, 'p'.repeat(MIB - before - bare))
}

// Table T — the title.
const TABLE_T: Array<{ id: string; lines: string[]; title: TranscriptMeta['title'] }> = [
  { id: 'T1 no title rows', lines: [user('/a')], title: null },
  { id: 'T2 the last generated title', lines: [aiTitle('one'), user('/a'), aiTitle('two')], title: { title: 'two', source: 'auto' } },
  { id: 'T3 a user-set title before a later generated one', lines: [aiTitle('one'), customTitle('mine'), aiTitle('later')], title: { title: 'mine', source: 'manual' } },
  { id: 'T3 the last user-set title', lines: [customTitle('mine'), customTitle('renamed'), aiTitle('later')], title: { title: 'renamed', source: 'manual' } },
  { id: 'T4 marker text in a body is not a title', lines: [aiTitle('real'), user('/b', {}, MARKER_BODY)], title: { title: 'real', source: 'auto' } },
  { id: 'T4 marker text alone gives no title', lines: [user('/b', {}, MARKER_BODY)], title: null },
  { id: 'T5 a title row starting 10 bytes before the chunk boundary', lines: [padTo(10), aiTitle('straddling'), user('/tail', {}, 'q'.repeat(2 * MIB))], title: { title: 'straddling', source: 'auto' } },
]

describe('Table T — title', () => {
  for (const row of TABLE_T) {
    test(row.id, async () => {
      const content = row.lines.join('\n')
      if (row.id.startsWith('T5')) expect(content.indexOf(aiTitle('straddling'))).toBe(MIB - 10)
      expect((await scanWithParity(content)).title).toEqual(row.title)
    })
  }
})

// Table C — the cwd: the newest candidate line, else null.
const long = 'x'.repeat(MIB - 40)
const TABLE_C: Array<{ id: string; content: string; cwd: string | null }> = [
  { id: 'C1 a plain record with a cwd is a candidate', content: [user('/first'), user('/second')].join('\n'), cwd: '/second' },
  { id: 'C2 an attachment snapshot working directory is a candidate', content: [user('/first'), attachment('/snap')].join('\n'), cwd: '/snap' },
  { id: 'C3 a meta record is not a candidate', content: [user('/kept'), user('/meta', { isMeta: true })].join('\n'), cwd: '/kept' },
  { id: 'C4 a sidechain record is not a candidate', content: [user('/kept'), user('/side', { isSidechain: true })].join('\n'), cwd: '/kept' },
  { id: 'C5 torn JSON is not a candidate', content: [user('/kept'), '{"cwd": "/torn'].join('\n'), cwd: '/kept' },
  { id: 'C5 a non-object line is not a candidate', content: [user('/kept'), '["cwd", "/array"]'].join('\n'), cwd: '/kept' },
  { id: 'C6 marker text in a body without a cwd field is not a candidate', content: [user('/kept'), user(undefined, {}, MARKER_BODY)].join('\n'), cwd: '/kept' },
  { id: 'C6 no candidate at all', content: [aiTitle('t'), user(undefined, {}, MARKER_BODY)].join('\n'), cwd: null },
  { id: 'C7 lines straddling the chunk, no final newline', content: [user('/before', {}, long), aiTitle('mid'), user('/after', {}, long + long), user('/last')].join('\n'), cwd: '/last' },
  { id: 'C7 lines straddling the chunk, final newline', content: `${[user('/before', {}, long), user('/after', {}, long + long)].join('\n')}\n`, cwd: '/after' },
  { id: 'C7 a cwd line starting 10 bytes before the chunk boundary', content: [padTo(10), user('/straddling'), user(undefined, {}, 'q'.repeat(MIB))].join('\n'), cwd: '/straddling' },
  { id: 'C8 CRLF endings and multibyte text', content: [user('/ünï/çødé', {}, '日本語 "cwd"'), aiTitle('タイトル')].join('\r\n'), cwd: '/ünï/çødé' },
  { id: 'C8 an empty file', content: '', cwd: null },
]

describe('Table C — cwd', () => {
  for (const row of TABLE_C) {
    test(row.id, async () => {
      expect((await scanWithParity(row.content)).cwd).toBe(row.cwd)
    })
  }

  test('C9 an unreadable file reads as nulls', async () => {
    expect(await scanTranscriptMeta(path.join(dir, 'missing.jsonl'))).toEqual({ title: null, cwd: null })
    expect(await scanTranscriptMeta(dir)).toEqual({ title: null, cwd: null })
  })
})

describe('P1 — parity property', () => {
  test('P1 matches the full parse over seeded random transcripts', async () => {
    let seed = 0x5eed
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return (seed >>> 16) % n
    }
    const pieces = [
      () => user(`/w${rand(5)}`),
      () => user(),
      () => user(`/m${rand(5)}`, { isMeta: true }),
      () => user(`/s${rand(5)}`, { isSidechain: true }),
      () => attachment(`/att${rand(5)}`),
      () => aiTitle(`ai ${rand(5)}`),
      () => customTitle(`custom ${rand(5)}`),
      () => user(`/q${rand(5)}`, {}, '"ai-title" "workingDirectory"'),
      () => '{"cwd": "/torn',
      () => '[1, 2]',
      () => '',
      () => user(`/big${rand(5)}`, {}, 'y'.repeat(rand(3) === 0 ? 300_000 : 10)),
    ]
    for (let round = 0; round < 60; round += 1) {
      const lines = Array.from({ length: 1 + rand(40) }, () => pieces[rand(pieces.length)]())
      await scanWithParity(lines.join(rand(2) === 0 ? '\n' : '\r\n'))
    }
  })
})
