// Property P1 — streamed parse parity (bounded-history-capture D2): for any
// content, the async file replay, which streams the file through `readLines`
// into a line consumer, gives exactly the events the string parser gives for
// the same content — ids and order included — for both runtimes. Seeded lines
// mix each parser's row kinds with torn JSON, blank lines, `\r\n`, multibyte
// text, lines longer than a chunk, and lines ending within 10 bytes of a
// chunk boundary; small chunk sizes push every line across reads as well.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRolloutParser, parseCodexRollout, replayCodexRollout, replayCodexRolloutAsync } from '../chat/codex/codexRollout'
import { LINE_CHUNK_BYTES, readLines } from '../chat/lineReader'
import { createTranscriptParser, parseTranscriptContent, replayTranscriptFile, replayTranscriptFileAsync } from '../chat/transcriptReplay'

const CASES = 50

function lcg(seed: number) {
  let state = seed >>> 0
  return (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 16) % n
  }
}

const TEXTS = ['hello', 'héllo wörld ✓', '日本語のテキスト', '🙂 done', 'line one\\nline two', '']
const at = (i: number) => `2026-10-04T10:00:${String(i % 60).padStart(2, '0')}.000Z`

const claudeRows: Array<(pick: (n: number) => number, i: number) => string> = [
  (pick, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: at(i), message: { role: 'user', content: TEXTS[pick(TEXTS.length)] || 'x' } }),
  (pick, i) => JSON.stringify({ type: 'assistant', uuid: `a${i}`, timestamp: at(i), message: { id: `msg_${pick(4)}`, role: 'assistant', content: [{ type: 'text', text: TEXTS[pick(TEXTS.length)] }] } }),
  (pick, i) => JSON.stringify({ type: 'assistant', uuid: `t${i}`, timestamp: at(i), message: { id: `msg_t${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `call_${pick(5)}`, name: 'Bash', input: { command: 'ls' } }] } }),
  (pick, i) => JSON.stringify({ type: 'user', uuid: `r${i}`, timestamp: at(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${pick(5)}`, content: 'ok', is_error: pick(2) === 0 }] } }),
  (_pick, i) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: `s${i}`, timestamp: at(i) }),
  (pick, i) => JSON.stringify({ type: 'ai-title', aiTitle: `Title ${pick(3)} ${i}` }),
  (pick, i) => JSON.stringify({ type: 'user', uuid: `c${i}`, timestamp: at(i), cwd: `/tmp/p${pick(3)}`, isSidechain: pick(4) === 0, message: { role: 'user', content: 'cwd row' } }),
  (_pick, i) => JSON.stringify({ type: 'assistant', uuid: `e${i}`, timestamp: at(i), isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Prompt is too long' }] } }),
]

const codexLine = (i: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(i), type, payload })
const codexRows: Array<(pick: (n: number) => number, i: number) => string> = [
  (_pick, i) => codexLine(i, 'event_msg', { type: 'task_started' }),
  (pick, i) => codexLine(i, 'event_msg', { type: 'task_complete', last_agent_message: TEXTS[pick(TEXTS.length)] }),
  (_pick, i) => codexLine(i, 'event_msg', { type: 'turn_aborted' }),
  (_pick, i) => codexLine(i, 'event_msg', { type: 'error', message: 'failed' }),
  (pick, i) => codexLine(i, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: TEXTS[pick(TEXTS.length)] || 'y' }] }),
  (pick, i) => codexLine(i, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXTS[pick(TEXTS.length)] }] }),
  (pick, i) => codexLine(i, 'response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: `call-${pick(4)}` }),
  (pick, i) => codexLine(i, 'response_item', { type: 'function_call_output', call_id: `call-${pick(4)}`, output: 'a.ts' }),
]

/** One case's content: seeded rows plus the noise and boundary lines. */
function generate(pick: (n: number) => number, rows: typeof claudeRows): string {
  const lines: string[] = []
  const count = 3 + pick(25)
  for (let i = 0; i < count; i += 1) {
    const roll = pick(20)
    if (roll === 0) lines.push('')
    else if (roll === 1) lines.push(rows[pick(rows.length)](pick, i).slice(0, 5 + pick(20)))
    else if (roll === 2) lines.push('   ')
    else lines.push(rows[pick(rows.length)](pick, i))
  }
  const crlf = pick(4) === 0
  let content = lines.join(crlf ? '\r\n' : '\n')
  const boundary = pick(3)
  if (boundary === 0) {
    // A filler row whose newline lands within 10 bytes of the chunk boundary.
    const used = Buffer.byteLength(content) + 1
    const shell = JSON.stringify({ type: 'file-history-snapshot', pad: '' })
    const padLength = LINE_CHUNK_BYTES - used - Buffer.byteLength(shell) - pick(11)
    const filler = JSON.stringify({ type: 'file-history-snapshot', pad: 'p'.repeat(Math.max(0, padLength)) })
    content += `\n${filler}\n${rows[pick(rows.length)](pick, count)}`
  } else if (boundary === 1) {
    // A line longer than one chunk, carrying multibyte text across it.
    content += `\n${JSON.stringify({ type: 'user', uuid: 'long', timestamp: at(0), message: { role: 'user', content: 'é'.repeat(LINE_CHUNK_BYTES / 2 + pick(1000)) } })}`
  }
  if (pick(2) === 0) content += '\n'
  return content
}

/** A few-byte chunk for small content; a 4 KiB one keeps the chunk-sized cases quick. */
const smallChunk = (pick: (n: number) => number, content: string) =>
  content.length < 1 << 16 ? 1 + pick(64) : 4096 + pick(64)

describe('P1 streamed parse parity', () => {
  let dir: string
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-parse-parity-')) })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('Claude transcripts: the streamed replay equals the string parse', async () => {
    const pick = lcg(0xb0a7)
    for (let c = 0; c < CASES; c += 1) {
      const content = generate(pick, claudeRows)
      const file = path.join(dir, `claude-${c}.jsonl`)
      fs.writeFileSync(file, content)
      const context = `case ${c}`
      expect([context, await replayTranscriptFileAsync(file)]).toEqual([context, replayTranscriptFile(file)])
      const parser = createTranscriptParser()
      await readLines(file, line => parser.line(line), smallChunk(pick, content))
      expect([context, parser.finish()]).toEqual([context, parseTranscriptContent(content)])
    }
  })

  test('Codex rollouts: the streamed replay equals the string parse', async () => {
    const pick = lcg(0xb0a7 ^ 0xc0de)
    for (let c = 0; c < CASES; c += 1) {
      const content = generate(pick, codexRows)
      const file = path.join(dir, `codex-${c}.jsonl`)
      fs.writeFileSync(file, content)
      const context = `case ${c}`
      expect([context, await replayCodexRolloutAsync(file)]).toEqual([context, replayCodexRollout(file)])
      const parser = createRolloutParser()
      await readLines(file, parser.line, smallChunk(pick, content))
      expect([context, parser.finish()]).toEqual([context, parseCodexRollout(content)])
    }
  })
})
