// The streaming boot meta reader (`scanTranscriptMeta`): for any transcript
// it answers exactly the full parse's `title` and `cwd` — title precedence,
// the newest cwd from a valid non-meta non-sidechain record, marker text
// inside message bodies, lines straddling the 1 MiB read chunk, a torn tail
// — and nulls for an unreadable file.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanTranscriptMeta } from '../chat/transcriptMeta'
import { parseTranscriptContent } from '../chat/transcriptReplay'

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

async function expectParity(content: string): Promise<void> {
  const parsed = parseTranscriptContent(content)
  const scanned = await scanTranscriptMeta(write(content))
  expect(scanned).toEqual({ title: parsed.title, cwd: parsed.cwd })
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

describe('scanTranscriptMeta', () => {
  test('a later generated title replaces an earlier one; a user-set one is terminal', async () => {
    await expectParity([aiTitle('one'), user('/a'), aiTitle('two')].join('\n'))
    await expectParity([aiTitle('one'), customTitle('mine'), aiTitle('later')].join('\n'))
    await expectParity([customTitle('mine'), customTitle('renamed'), aiTitle('later')].join('\n'))
    const scanned = await scanTranscriptMeta(write([aiTitle('one'), customTitle('mine'), aiTitle('later')].join('\n')))
    expect(scanned.title).toEqual({ title: 'mine', source: 'manual' })
  })

  test('the newest cwd skips meta, sidechain, and invalid lines', async () => {
    const content = [
      user('/first'),
      attachment('/second'),
      user('/meta', { isMeta: true }),
      user('/side', { isSidechain: true }),
      '{"cwd": "/torn',
    ].join('\n')
    await expectParity(content)
    expect((await scanTranscriptMeta(write(content))).cwd).toBe('/second')
  })

  test('marker text inside a message body neither titles nor hides its cwd', async () => {
    const body = 'the rows are "ai-title" and "custom-title"; "cwd" too'
    await expectParity([aiTitle('real'), user('/body', {}, body)].join('\n'))
    await expectParity([user('/a'), JSON.stringify({ type: 'ai-title', aiTitle: '' }), user(undefined, {}, body)].join('\n'))
  })

  test('lines straddling the read chunk and a file without a final newline', async () => {
    const long = 'x'.repeat((1 << 20) - 40)
    const content = [user('/before', {}, long), aiTitle('mid'), user('/after', {}, long + long), user('/last')].join('\n')
    await expectParity(content)
    await expectParity(`${content}\n`)
    expect((await scanTranscriptMeta(write(content))).cwd).toBe('/last')
  })

  test('a title row that starts just before the chunk boundary', async () => {
    // Pad the first line so the title row begins 10 bytes before 1 MiB: its
    // head is carried across the next read into the reused buffer.
    const head = user('/pad', {}, '')
    const pad = (1 << 20) - 10 - (Buffer.byteLength(head) + 1)
    const content = [user('/pad', {}, 'p'.repeat(pad)), aiTitle('straddling'), user('/tail', {}, 'q'.repeat(2 << 20))].join('\n')
    expect(content.indexOf(aiTitle('straddling'))).toBe((1 << 20) - 10)
    await expectParity(content)
    expect((await scanTranscriptMeta(write(content))).title).toEqual({ title: 'straddling', source: 'auto' })
  })

  test('a transcript holding neither field, an empty file, and multibyte text', async () => {
    await expectParity(JSON.stringify({ type: 'assistant', message: { content: [] } }))
    await expectParity('')
    await expectParity([user('/ünï/çødé', {}, '日本語 "cwd"'), aiTitle('タイトル')].join('\r\n'))
  })

  test('an unreadable file reads as nulls', async () => {
    expect(await scanTranscriptMeta(path.join(dir, 'missing.jsonl'))).toEqual({ title: null, cwd: null })
    expect(await scanTranscriptMeta(dir)).toEqual({ title: null, cwd: null })
  })

  test('matches the full parse over seeded random transcripts', async () => {
    let seed = 0x5eed
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
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
      await expectParity(lines.join(rand(2) === 0 ? '\n' : '\r\n'))
    }
  })
})
