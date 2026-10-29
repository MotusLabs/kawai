// Chunked line reading (bounded-history-capture D2, task 2.1): `readLines`
// hands out exactly the pieces `content.split('\n')` gives, with their
// indexes, whatever the chunk size — a line straddling chunks, a final line
// without a newline, `\r\n` endings, and multibyte text split mid-character.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLines } from '../chat/lineReader'

describe('readLines', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-line-reader-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const read = async (content: string | Buffer, chunkBytes: number) => {
    const file = path.join(dir, 'f.jsonl')
    fs.writeFileSync(file, content)
    const lines: Array<[string, number]> = []
    await readLines(file, (line, index) => lines.push([line, index]), chunkBytes)
    return lines
  }
  const pieces = (content: string) => content.split('\n').map((line, index): [string, number] => [line, index])

  const cases: Array<[string, string]> = [
    ['a line straddling a chunk', 'short\n0123456789abcdefghij\nend\n'],
    ['a final line without a newline', 'one\ntwo\nthree'],
    ['crlf endings keep their \\r', 'one\r\ntwo\r\n\r\nthree\r\n'],
    ['blank lines and a trailing newline', '\n\nx\n\n'],
    ['multibyte text split mid-character', 'héllo wörld ✓\n日本語のテキスト\n🙂🙂🙂\n'],
    ['an empty file', ''],
  ]
  for (const [name, content] of cases) {
    for (const chunkBytes of [1, 3, 7, 1 << 20]) {
      test(`${name} (chunk ${chunkBytes})`, async () => {
        expect(await read(content, chunkBytes)).toEqual(pieces(content))
      })
    }
  }

  test('an open error rejects with its code', async () => {
    let code: string | undefined
    try { await readLines(path.join(dir, 'missing.jsonl'), () => {}) } catch (error) {
      code = (error as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ENOENT')
  })
})
