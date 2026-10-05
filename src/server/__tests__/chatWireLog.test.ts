import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatWireFrame } from '../../shared/chat'
import { ChatWireLog } from '../chat/ChatWireLog'
import { ChatWireLogs } from '../chat/ChatWireLogs'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-wire-'))
  dirs.push(dir)
  return path.join(dir, 'chat-wire')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const seqs = (frames: ChatWireFrame[]) => frames.map(frame => frame.seq)
const fileLines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as ChatWireFrame)

describe('ChatWireLog', () => {
  test('assigns sequences synchronously and appends frames in order', async () => {
    const dir = tempDir()
    const seen: ChatWireFrame[] = []
    const log = new ChatWireLog({ dir, sessionId: 'chat-1', onFrame: frame => seen.push(frame) })
    log.record('lifecycle', '{"event":"spawn"}')
    log.record('out', '{"type":"user"}')
    log.record('in', 'not json')
    expect(seqs(seen)).toEqual([1, 2, 3])
    expect(log.lastSeq).toBe(3)
    await log.flush()
    const frames = fileLines(log.currentPath)
    expect(frames.map(frame => [frame.seq, frame.dir, frame.raw])).toEqual([
      [1, 'lifecycle', '{"event":"spawn"}'], [2, 'out', '{"type":"user"}'], [3, 'in', 'not json'],
    ])
    expect(typeof frames[0]!.at).toBe('string')
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(log.currentPath).mode & 0o777).toBe(0o600)
  })

  test('writes frames recorded in one tick without an explicit flush', async () => {
    const log = new ChatWireLog({ dir: tempDir(), sessionId: 'chat-1' })
    for (let index = 0; index < 50; index += 1) log.record('in', `line-${index}`)
    await new Promise(resolve => setTimeout(resolve, 20))
    await log.flush()
    expect(seqs(fileLines(log.currentPath))).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
  })

  test('rotates at the size bound, keeps the newest frames, and continues', async () => {
    const log = new ChatWireLog({ dir: tempDir(), sessionId: 'chat-1', maxFileBytes: 400 })
    for (let index = 0; index < 40; index += 1) {
      log.record('in', `frame-${index}-${'x'.repeat(40)}`)
      await log.flush()
    }
    expect(fs.existsSync(log.rotatedPath)).toBe(true)
    const page = await log.readPage({ limit: 1000 })
    expect(page.frames.at(-1)!.seq).toBe(40)
    expect(page.frames[0]!.seq).toBeGreaterThan(1)
    const retained = seqs(page.frames)
    expect(retained).toEqual(Array.from({ length: retained.length }, (_, index) => retained[0]! + index))
    log.record('out', 'after rotation')
    expect((await log.readPage({ limit: 1 })).frames[0]).toMatchObject({ seq: 41, raw: 'after rotation' })
  })

  test('resumes the sequence from the current file, then the rotated one', async () => {
    const dir = tempDir()
    const first = new ChatWireLog({ dir, sessionId: 'chat-1' })
    for (let index = 0; index < 5; index += 1) first.record('in', `line-${index}`)
    await first.flush()
    // A torn trailing line from a crash mid-append is skipped.
    fs.appendFileSync(first.currentPath, '{"seq":99,"raw":')
    const second = new ChatWireLog({ dir, sessionId: 'chat-1' })
    expect(second.lastSeq).toBe(5)
    second.record('out', 'next')
    expect(second.lastSeq).toBe(6)
    await second.flush()

    fs.renameSync(second.currentPath, second.rotatedPath)
    expect(new ChatWireLog({ dir, sessionId: 'chat-1' }).lastSeq).toBe(6)
    expect(new ChatWireLog({ dir, sessionId: 'chat-2' }).lastSeq).toBe(0)
  })

  test('resumes from a large file without reading it whole in one window', async () => {
    const log = new ChatWireLog({ dir: tempDir(), sessionId: 'chat-1' })
    log.record('in', 'a'.repeat(300 * 1024))
    log.record('in', 'b'.repeat(100 * 1024))
    await log.flush()
    expect(new ChatWireLog({ dir: path.dirname(log.currentPath), sessionId: 'chat-1' }).lastSeq).toBe(2)
  })

  test('pages newest first window, older windows, and across the rotation boundary', async () => {
    const log = new ChatWireLog({ dir: tempDir(), sessionId: 'chat-1', maxFileBytes: 600 })
    for (let index = 0; index < 20; index += 1) {
      log.record('in', `frame-${index}`)
      await log.flush()
    }
    const all = await log.readPage({ limit: 1000 })
    const oldest = all.frames[0]!.seq
    expect(all.hasOlder).toBe(false)

    const collected: number[] = []
    let page = await log.readPage({ limit: 3 })
    collected.unshift(...seqs(page.frames))
    while (page.hasOlder) {
      page = await log.readPage({ beforeSeq: page.frames[0]!.seq, limit: 3 })
      collected.unshift(...seqs(page.frames))
    }
    expect(collected).toEqual(Array.from({ length: 20 - oldest + 1 }, (_, index) => oldest + index))
  })

  test('pages include frames not yet flushed and an empty log has no frames', async () => {
    const log = new ChatWireLog({ dir: tempDir(), sessionId: 'chat-1' })
    expect(await log.readPage({ limit: 10 })).toEqual({ frames: [], hasOlder: false })
    log.record('in', 'pending')
    expect(seqs((await log.readPage({ limit: 10 })).frames)).toEqual([1])
  })

  test('write failures never throw and are reported once', async () => {
    const parent = tempDir()
    fs.mkdirSync(path.dirname(parent), { recursive: true })
    fs.writeFileSync(parent, 'a file where the directory should be')
    const errors: unknown[] = []
    const log = new ChatWireLog({ dir: parent, sessionId: 'chat-1', onWriteError: error => errors.push(error) })
    expect(() => log.record('in', 'one')).not.toThrow()
    await log.flush()
    log.record('in', 'two')
    await log.flush()
    expect(errors).toHaveLength(1)
    expect(log.lastSeq).toBe(2)
  })

  test('delete removes both generations and ignores later records', async () => {
    const log = new ChatWireLog({ dir: tempDir(), sessionId: 'chat-1', maxFileBytes: 100 })
    log.record('in', 'x'.repeat(60))
    await log.flush()
    log.record('in', 'y')
    await log.flush()
    expect(fs.existsSync(log.rotatedPath) && fs.existsSync(log.currentPath)).toBe(true)
    await log.delete()
    log.record('in', 'ignored')
    await log.flush()
    expect(fs.existsSync(log.rotatedPath) || fs.existsSync(log.currentPath)).toBe(false)
  })
})

describe('ChatWireLogs', () => {
  test('fans out recorded frames to subscribers until they unsubscribe', () => {
    const logs = new ChatWireLogs({ dir: tempDir() })
    const a: number[] = []
    const b: number[] = []
    const stopA = logs.subscribe('chat-1', frame => a.push(frame.seq))
    logs.subscribe('chat-1', frame => b.push(frame.seq))
    logs.subscribe('chat-2', () => { throw new Error('wrong session') })
    logs.get('chat-1').record('in', 'one')
    stopA()
    logs.get('chat-1').record('in', 'two')
    expect(a).toEqual([1])
    expect(b).toEqual([1, 2])
    expect(logs.get('chat-1')).toBe(logs.get('chat-1'))
  })

  test('rejects unsafe session ids', () => {
    const logs = new ChatWireLogs({ dir: tempDir() })
    expect(() => logs.get('../escape')).toThrow()
  })

  test('delete removes the files and a later log starts fresh', async () => {
    const logs = new ChatWireLogs({ dir: tempDir(), maxFileBytes: 100 })
    const log = logs.get('chat-1')
    log.record('in', 'x'.repeat(60))
    await log.flush()
    log.record('in', 'y')
    await log.flush()
    await logs.delete('chat-1')
    await logs.delete('../ignored')
    expect(fs.readdirSync(logs.dir)).toEqual([])
    expect(logs.get('chat-1').lastSeq).toBe(0)
  })

  test('pruneOrphans deletes logs of unknown sessions only', async () => {
    const logs = new ChatWireLogs({ dir: tempDir(), maxFileBytes: 100 })
    for (const id of ['chat-keep', 'chat-gone']) {
      logs.get(id).record('in', 'x'.repeat(60))
      await logs.get(id).flush()
      logs.get(id).record('in', 'y')
      await logs.get(id).flush()
    }
    fs.writeFileSync(path.join(logs.dir, 'unrelated.txt'), 'keep')
    await logs.pruneOrphans(new Set(['chat-keep']))
    expect(fs.readdirSync(logs.dir).sort()).toEqual(['chat-keep.1.jsonl', 'chat-keep.jsonl', 'unrelated.txt'])
    await new ChatWireLogs({ dir: path.join(logs.dir, 'missing') }).pruneOrphans(new Set())
  })

  test('readPage reads through the session log', async () => {
    const logs = new ChatWireLogs({ dir: tempDir() })
    logs.get('chat-1').record('out', 'hello')
    expect((await logs.readPage('chat-1', { limit: 5 })).frames.map(frame => frame.raw)).toEqual(['hello'])
  })
})
