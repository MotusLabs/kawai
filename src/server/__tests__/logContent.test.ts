import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readLogLineWindow, logLineCacheTestHooks } from '../logContent'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'logcontent-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  logLineCacheTestHooks.reset()
})

describe('readLogLineWindow', () => {
  test('returns the tail window of a small log', async () => {
    const file = path.join(dir, 'small.log')
    await fs.writeFile(file, `${Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n')}\n`)
    const stats = await fs.stat(file)

    const window = await readLogLineWindow(file, stats, 5, Number.POSITIVE_INFINITY)

    expect(window.totalLines).toBe(10)
    expect(window.startLine).toBe(5)
    expect(window.lines).toEqual(['line-5', 'line-6', 'line-7', 'line-8', 'line-9'])
    expect(window.hasMoreBefore).toBe(true)
  })

  test('honors beforeLine for earlier pages', async () => {
    const file = path.join(dir, 'small.log')
    await fs.writeFile(file, `${Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n')}\n`)
    const stats = await fs.stat(file)

    const window = await readLogLineWindow(file, stats, 5, 5)

    expect(window.lines).toEqual(['line-0', 'line-1', 'line-2', 'line-3', 'line-4'])
    expect(window.hasMoreBefore).toBe(false)
  })

  test('invalidates a cached log when the file is rewritten', async () => {
    const file = path.join(dir, 'mutable.log')
    await fs.writeFile(file, 'aaa\nbbb\n')
    let stats = await fs.stat(file)
    const first = await readLogLineWindow(file, stats, 10, Number.POSITIVE_INFINITY)
    expect(first.lines).toEqual(['aaa', 'bbb'])

    await fs.writeFile(file, 'aaa\nbbb\nccc\nddd\n')
    stats = await fs.stat(file)
    const second = await readLogLineWindow(file, stats, 10, Number.POSITIVE_INFINITY)
    expect(second.lines).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
  })

  test('serves a repeated read from the cache without recounting', async () => {
    const file = path.join(dir, 'cached.log')
    await fs.writeFile(file, 'one\ntwo\nthree\n')
    const stats = await fs.stat(file)

    await readLogLineWindow(file, stats, 10, Number.POSITIVE_INFINITY)
    expect(logLineCacheTestHooks.cache.has(file)).toBe(true)

    const again = await readLogLineWindow(file, stats, 2, Number.POSITIVE_INFINITY)
    expect(again.lines).toEqual(['two', 'three'])
    expect(again.totalLines).toBe(3)
  })

  test('uses byte cursors for oversized logs opened at the end', async () => {
    const file = path.join(dir, 'big.log')
    const lineCount = 400_000
    const pad = 'x'.repeat(10)
    await fs.writeFile(file, `${Array.from({ length: lineCount }, (_, i) => `${pad}${i}`).join('\n')}\n`)
    const stats = await fs.stat(file)
    expect(stats.size).toBeGreaterThan(4 * 1024 * 1024)

    const window = await readLogLineWindow(file, stats, 3, Number.POSITIVE_INFINITY)

    expect(window.totalLines).toBeNull()
    expect(window.lines.length).toBe(3)
    expect(window.lines[2]).toBe(`${pad}${lineCount - 1}`)
    expect(window.endByte).toBe(stats.size)
    expect(window.startByte).toBeGreaterThan(0)
    expect(window.lineKeys?.length).toBe(3)
    expect(logLineCacheTestHooks.cache.has(file)).toBe(false)
  })

  test('pages backwards through an oversized log with the returned cursor', async () => {
    const file = path.join(dir, 'big.log')
    const lineCount = 400_000
    const pad = 'x'.repeat(10)
    await fs.writeFile(file, `${Array.from({ length: lineCount }, (_, i) => `${pad}${i}`).join('\n')}\n`)
    const stats = await fs.stat(file)

    const tail = await readLogLineWindow(file, stats, 3, Number.POSITIVE_INFINITY)
    const earlier = await readLogLineWindow(file, stats, 3, Number.POSITIVE_INFINITY, tail.startByte)

    expect(earlier.endByte).toBe(tail.startByte)
    expect(earlier.lines.length).toBe(3)
    expect(earlier.lines[2]).toBe(`${pad}${lineCount - 4}`)
    expect(earlier.hasMoreBefore).toBe(true)
  })

  test('streams a bounded window for oversized logs with a finite beforeLine', async () => {
    const file = path.join(dir, 'big.log')
    const lineCount = 400_000
    const pad = 'x'.repeat(10)
    await fs.writeFile(file, `${Array.from({ length: lineCount }, (_, i) => `${pad}${i}`).join('\n')}\n`)
    const stats = await fs.stat(file)

    const window = await readLogLineWindow(file, stats, 4, 100)

    expect(window.totalLines).toBe(lineCount)
    expect(window.lines).toEqual([`${pad}96`, `${pad}97`, `${pad}98`, `${pad}99`])
    expect(window.hasMoreBefore).toBe(true)
    expect(logLineCacheTestHooks.cache.has(file)).toBe(false)
  })
})

describe('log line cache budget', () => {
  test('evicts the oldest entries past the byte budget', () => {
    logLineCacheTestHooks.seed([
      { key: 'old', size: 10_000_000, mtimeMs: 1 },
      { key: 'mid', size: 5_000_000, mtimeMs: 2 },
    ])
    expect(logLineCacheTestHooks.cache.has('old')).toBe(true)

    logLineCacheTestHooks.seed([{ key: 'new', size: 5_000_000, mtimeMs: 3 }])

    // 20MB total exceeds the 16MB budget; the oldest entry ('old') is evicted.
    expect(logLineCacheTestHooks.cache.has('old')).toBe(false)
    expect(logLineCacheTestHooks.cache.has('mid')).toBe(true)
    expect(logLineCacheTestHooks.cache.has('new')).toBe(true)
    expect(logLineCacheTestHooks.bytes()).toBe(10_000_000)
  })
})
