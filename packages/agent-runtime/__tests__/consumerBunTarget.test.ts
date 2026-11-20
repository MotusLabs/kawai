// Controls for the consumer Bun target selection: the default target is the
// check runner verified against its own version, an explicit override must
// declare the version its executable must report, and a wrong, undeclared
// or silent target fails before any consumer compatibility pass. The real
// minimum-1.3.0 evidence is the release workflow's minimum-consumer
// invocation, which sets CONSUMER_BUN and CONSUMER_BUN_VERSION together.
import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConsumerBun, verifyConsumerBun } from './helpers/consumerBunTarget.js'

test('consumer Bun target: the default selection is the check runner itself, verified against its actual version', () => {
  const target = resolveConsumerBun({})
  expect(target).toEqual({ executable: process.execPath, expected: process.versions.bun })
  expect(verifyConsumerBun(target)).toBe(process.versions.bun)
})

test('consumer Bun target: an override whose executable reports its declared version passes verification', () => {
  const target = resolveConsumerBun({ CONSUMER_BUN: process.execPath, CONSUMER_BUN_VERSION: process.versions.bun })
  expect(target.executable).toBe(process.execPath)
  expect(target.expected).toBe(process.versions.bun)
  expect(verifyConsumerBun(target)).toBe(process.versions.bun)
})

test('consumer Bun target: an executable whose version differs from the declared expectation fails before any compatibility pass', () => {
  const target = resolveConsumerBun({ CONSUMER_BUN: process.execPath, CONSUMER_BUN_VERSION: '0.0.0-no-such-bun' })
  expect(() => verifyConsumerBun(target)).toThrow('consumer Bun target mismatch')
})

test('consumer Bun target: an override without a declared expected version is refused before any run', () => {
  expect(() => resolveConsumerBun({ CONSUMER_BUN: process.execPath })).toThrow('CONSUMER_BUN_VERSION')
})

test('consumer Bun target: a selected executable that cannot report a version fails verification', () => {
  // The missing executable is a fixture path in the OS temp dir, never a
  // repository file: the spawn fails closed with the same mismatch error.
  const missing = join(tmpdir(), `missing-consumer-bun-${process.pid}`)
  expect(() => verifyConsumerBun({ executable: missing, expected: process.versions.bun })).toThrow('consumer Bun target mismatch')
})
