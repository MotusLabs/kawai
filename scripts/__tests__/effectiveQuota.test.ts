// effectiveQuota.test.ts — the CPU-cap decision, moved verbatim from
// testRunner.test.ts (N2): its own file leaves room for the cpu.max stub
// test that replaces the constant-reader coincidence below.
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import { effectiveQuota, readCpuQuota } from '../test-runner'

describe('effectiveQuota', () => {
  test('prefers the cgroup cpu.max over the platform parallelism (F7)', () => {
    expect(effectiveQuota(() => 2)).toBe(2)
    expect(effectiveQuota(() => 9)).toBe(9)
  })

  test('falls back to the platform parallelism when cpu.max is absent', () => {
    expect(effectiveQuota(() => null)).toBe(os.availableParallelism())
  })

  test('the default reader is the production cgroup read (F6)', () => {
    // The default parameter binds the production reader, not a constant.
    expect(effectiveQuota()).toBe(readCpuQuota() ?? os.availableParallelism())
  })
})
