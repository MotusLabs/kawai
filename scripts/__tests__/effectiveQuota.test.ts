// effectiveQuota.test.ts — the CPU-cap decision, moved verbatim from
// testRunner.test.ts (N2): its own file carries the cpu.max stub test that
// replaces the constant-reader coincidence, with its own afterEach.
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import { effectiveQuota } from '../lib/workerCount'

describe('effectiveQuota', () => {
  test('prefers the cgroup cpu.max over the platform parallelism (F7)', () => {
    expect(effectiveQuota(() => 2)).toBe(2)
    expect(effectiveQuota(() => 9)).toBe(9)
  })

  test('falls back to the platform parallelism when cpu.max is absent', () => {
    expect(effectiveQuota(() => null)).toBe(os.availableParallelism())
  })
})

describe('the default reader reads cpu.max (N2)', () => {
  const realReadFileSync = fs.readFileSync
  let contents: string[] = []

  afterEach(() => {
    fs.readFileSync = realReadFileSync
    contents = []
  })

  test('effectiveQuota() follows the production read as the quota changes', () => {
    // The host's quota can coincide with any constant (N2), so the read
    // itself is stubbed: the first call sees 2 CPUs, the second 7.
    contents = ['200000 100000', '700000 100000']
    fs.readFileSync = ((file: unknown, ...rest: unknown[]) => {
      if (file === '/sys/fs/cgroup/cpu.max') {
        const content = contents.shift()
        if (content === undefined) throw new Error('unexpected extra cpu.max read')
        return content
      }
      return (realReadFileSync as (...args: unknown[]) => ReturnType<typeof fs.readFileSync>)(file, ...rest)
    }) as typeof fs.readFileSync
    expect(effectiveQuota()).toBe(2)
    expect(effectiveQuota()).toBe(7)
    expect(contents).toEqual([])
  })
})
