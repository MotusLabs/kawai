// gitCommand.test.ts - runGit contract: leaked GIT_DIR-family environment
// variables must not override the explicit cwd. Git exports GIT_DIR and
// GIT_COMMON_DIR to hook scripts, so the pre-commit test gate (and any server
// started from a hook) would otherwise resolve every command against the
// hook's repository instead of the requested working directory.
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as bootstrapFs from 'node:fs'
import * as bootstrapOs from 'node:os'
import { runGit, runGitAsync } from '../git/gitCommand'
import { createOwnedGitContext } from '../git/ownedGitCommand'
import { createRecord, lateAttempt, settleRecord } from '../git/ownedGitRecord'
import type { OwnedRecord, OwnedReason } from '../git/ownedGitRecord'
import { decodeGitResultFrame } from '../git/ownedGitProtocol'
import * as startupModule from '../git/ownedGitStartup'

let tempRoot: string
let repoA: string
let repoB: string

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-gitcmd-'))
  repoA = path.join(tempRoot, 'repo-a')
  repoB = path.join(tempRoot, 'repo-b')
  for (const repo of [repoA, repoB]) {
    const init = runGit(['init', '--initial-branch=main', repo], { timeoutMs: 5000 })
    if (!init.ok) {
      throw new Error(`git init failed for ${repo}: ${init.stderr.trim()}`)
    }
  }
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('runGitAsync environment hygiene', () => {
  test('ignores GIT_DIR/GIT_COMMON_DIR leaked into the environment', async () => {
    const previousGitDir = process.env.GIT_DIR
    const previousCommonDir = process.env.GIT_COMMON_DIR
    process.env.GIT_DIR = path.join(repoA, '.git')
    process.env.GIT_COMMON_DIR = path.join(repoA, '.git')
    try {
      const result = await runGitAsync(
        ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
        { cwd: repoB }
      )
      expect(result.ok).toBe(true)
      const [commonDir, toplevel] = result.stdout.trim().split('\n').map((line) => line.trim())
      expect(commonDir).toBe(path.join(repoB, '.git'))
      expect(toplevel).toBe(repoB)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousCommonDir === undefined) delete process.env.GIT_COMMON_DIR
      else process.env.GIT_COMMON_DIR = previousCommonDir
    }
  })

  test('still honors an explicit GIT_DIR passed through the env option', async () => {
    const result = await runGitAsync(['rev-parse', '--git-dir'], {
      cwd: repoB,
      env: { GIT_DIR: path.join(repoA, '.git') },
    })
    expect(result.ok).toBe(true)
    expect(result.stdout.trim()).toBe(path.join(repoA, '.git'))
  })

  test('kills a hung git at the timeout and reports non-success', async () => {
    // A PATH shim swaps git for a sleeper, so the kill is deterministic: the
    // command would run far past the timeout if it were never killed.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-gitshim-'))
    fs.writeFileSync(path.join(shimDir, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
    const previousPath = process.env.PATH
    process.env.PATH = `${shimDir}:${previousPath ?? ''}`
    try {
      const result = await runGitAsync(['rev-parse', '--git-dir'], {
        cwd: repoB,
        timeoutMs: 150,
      })
      expect(result.ok).toBe(false)
      expect(result.exitCode).not.toBe(0)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      fs.rmSync(shimDir, { recursive: true, force: true })
    }
  })
})

describe('runGit environment hygiene', () => {
  test('ignores GIT_DIR/GIT_COMMON_DIR leaked into the environment', () => {
    // Simulate git's hook exports pointing at an unrelated repository.
    const previousGitDir = process.env.GIT_DIR
    const previousCommonDir = process.env.GIT_COMMON_DIR
    process.env.GIT_DIR = path.join(repoA, '.git')
    process.env.GIT_COMMON_DIR = path.join(repoA, '.git')
    try {
      const result = runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
        { cwd: repoB }
      )
      expect(result.ok).toBe(true)
      const [commonDir, toplevel] = result.stdout.trim().split('\n').map((line) => line.trim())
      expect(commonDir).toBe(path.join(repoB, '.git'))
      expect(toplevel).toBe(repoB)
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousCommonDir === undefined) delete process.env.GIT_COMMON_DIR
      else process.env.GIT_COMMON_DIR = previousCommonDir
    }
  })

  test('still honors an explicit GIT_DIR passed through the env option', () => {
    const result = runGit(['rev-parse', '--git-dir'], {
      cwd: repoB,
      env: { GIT_DIR: path.join(repoA, '.git') },
    })
    expect(result.ok).toBe(true)
    expect(result.stdout.trim()).toBe(path.join(repoA, '.git'))
  })
})


// Supplied states below test policy only; no native custody or group-absence proof.
function settledPolicyRecord(code: 0 | 128 = 0): OwnedRecord {
  const record = createRecord(3)
  record.invoked = true
  record.pid = 41
  record.joined = record.ownerExited = record.expectedExit = true
  record.hello = record.started = record.runSent = record.closing = record.finalSent = true
  record.statusTerminal = record.capturesStarted = record.physicalReady = true
  record.terminal = [true, true]
  record.eof = [true, true]
  record.tuple = { type: 'GIT_RESULT', code, signal: null }
  record.output = ['abcdef', 'uvwxyz']
  return record
}
function suppliedAbsentGroup() {
  return mock((pid: number) => {
    expect(pid).toBe(41)
    throw Object.assign(new Error('supplied policy ESRCH'), { code: 'ESRCH' })
  })
}
const terminalSources: readonly ('owner' | 'stdout' | 'stderr' | 'status')[] = ['owner', 'stdout', 'stderr', 'status']

test('owned policy preserves normal 0 and ordinary 128 with one supplied ESRCH', () => {
  const codes: readonly (0 | 128)[] = [0, 128]
  for (const code of codes) {
    const record = settledPolicyRecord(code), query = suppliedAbsentGroup()
    const result = settleRecord(record, query)
    expect(result).toEqual({
      ok: code === 0, exitCode: code, stdout: 'abc', stderr: 'uvw', cleanup: 'proved',
      cleanupDetails: { outcome: 'complete', reason: null, ownerJoined: true, captures: 'complete', joinPending: false },
    })
    expect(Object.hasOwn(result, 'failureOrigin')).toBe(false)
    expect(record.retired).toBe(true)
    expect(record.queryUsed).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  }
})

test('owned policy keeps observed timeout UNKNOWN despite Git 0 and resource retirement', () => {
  const record = settledPolicyRecord(), query = suppliedAbsentGroup()
  record.timeout = true
  const result = settleRecord(record, query)
  const expected = {
    ok: true, exitCode: 0, stdout: 'abc', stderr: 'uvw', failureOrigin: 'timeout', cleanup: 'unknown',
    cleanupDetails: { outcome: 'failed', reason: 'timeout', ownerJoined: true, captures: 'complete', joinPending: false },
  } as const
  expect(result).toEqual(expected)
  expect(record.retired).toBe(true)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.cleanupDetails)).toBe(true)
  expect(Reflect.set(result, 'cleanup', 'proved')).toBe(false)
  expect(Reflect.set(result.cleanupDetails, 'reason', null)).toBe(false)
  for (const source of terminalSources) lateAttempt(record, source, query)
  expect(query).toHaveBeenCalledTimes(1)
  expect(record.result).toBe(result)
  expect(result).toEqual(expected)
})

test('owned policy keeps signal UNKNOWN below independent own faults and rejects untrusted tuples', () => {
  const examples: { capture: boolean; protocol: boolean; timeout: boolean; reason: OwnedReason; origin?: 'capture' | 'timeout' }[] = [
    { capture: false, protocol: false, timeout: false, reason: 'git-signal' },
    { capture: true, protocol: false, timeout: false, reason: 'capture', origin: 'capture' },
    { capture: false, protocol: true, timeout: false, reason: 'protocol' },
    { capture: true, protocol: true, timeout: false, reason: 'capture', origin: 'capture' },
    { capture: true, protocol: true, timeout: true, reason: 'timeout', origin: 'timeout' },
  ]
  for (const example of examples) {
    const record = settledPolicyRecord(), query = suppliedAbsentGroup()
    record.tuple = { type: 'GIT_RESULT', code: null, signal: 'SIGTERM' }
    record.captureFault = example.capture
    record.timeout = example.timeout
    if (example.protocol) record.fault = 'protocol'
    const result = settleRecord(record, query)
    expect([result.ok, result.exitCode, result.cleanup]).toEqual([false, null, 'unknown'])
    expect(result.cleanupDetails.reason).toBe(example.reason)
    expect(result.failureOrigin).toBe(example.origin)
    expect(record.retired).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  }
  for (const text of ['{"type":"GIT_RESULT","code":0}', '{"type":"GIT_RESULT","code":0,"signal":""}', '{"type":"GIT_RESULT","code":null,"signal":null}']) {
    const record = settledPolicyRecord(), query = suppliedAbsentGroup()
    const tuple = decodeGitResultFrame(Buffer.from(text))
    expect(tuple).toBeNull()
    record.tuple = tuple ?? undefined
    const result = settleRecord(record, query)
    expect([result.ok, result.exitCode, result.cleanup, result.cleanupDetails.reason]).toEqual([false, null, 'unknown', 'protocol'])
  }
})

test('owned policy refuses incomplete custody and distinguishes never-started from uncertain spawn', () => {
  const gaps: readonly ('join' | 'collectors' | 'disposal')[] = ['join', 'collectors', 'disposal']
  for (const gap of gaps) {
    const record = settledPolicyRecord(), query = suppliedAbsentGroup()
    if (gap === 'join') { record.joined = false; record.graceExpired = true }
    if (gap === 'collectors') { record.terminal = [true, false]; record.graceExpired = true }
    if (gap === 'disposal') record.physicalReady = false
    const result = settleRecord(record, query)
    const reason = ({ join: 'join-grace', collectors: 'capture-grace', disposal: 'resource-disposal' } as const)[gap]
    expect(result.cleanup).toBe('unknown')
    expect(result.cleanupDetails).toEqual({
      outcome: 'failed', reason, ownerJoined: gap !== 'join',
      captures: gap === 'collectors' ? 'pending' : 'complete', joinPending: gap === 'join',
    })
    expect(record.retired).toBe(false)
    expect(query).toHaveBeenCalledTimes(0)
  }
  for (const invoked of [false, true]) {
    const record = createRecord(3), query = suppliedAbsentGroup()
    record.physicalReady = true
    record.invoked = invoked
    if (invoked) record.spawnFault = true
    else record.local = 'executable'
    const result = settleRecord(record, query)
    expect(result.cleanup).toBe('unknown')
    expect(result.cleanupDetails).toEqual({
      outcome: 'failed', reason: invoked ? 'spawn' : 'executable',
      ownerJoined: false, captures: 'not-started', joinPending: invoked,
    })
    expect(record.retired).toBe(!invoked)
    expect(record.queryUsed).toBe(false)
    expect(query).toHaveBeenCalledTimes(0)
  }
})

test('owned policy retains a present group and never repeats its one observation', () => {
  const record = settledPolicyRecord()
  const query = mock((pid: number) => { expect(pid).toBe(41) })
  const result = settleRecord(record, query), original = JSON.stringify(result)
  expect([result.cleanup, result.cleanupDetails.reason, record.retired]).toEqual(['unknown', 'group-present', false])
  for (const source of [...terminalSources, ...terminalSources]) lateAttempt(record, source, query)
  expect(query).toHaveBeenCalledTimes(1)
  expect(record.queryUsed).toBe(true)
  expect(record.result).toBe(result)
  expect(JSON.stringify(result)).toBe(original)
})

test('owned policy allows only a new late terminal source and preserves the P23 disposal limit', () => {
  const record = settledPolicyRecord(), query = suppliedAbsentGroup()
  record.joined = record.physicalReady = false
  record.terminal = [false, false]
  record.graceExpired = true
  const result = settleRecord(record, query), original = JSON.stringify(result)
  expect(result.cleanupDetails).toEqual({
    outcome: 'failed', reason: 'join-grace', ownerJoined: false, captures: 'pending', joinPending: true,
  })
  expect(query).toHaveBeenCalledTimes(0)
  record.joined = record.physicalReady = true
  record.terminal = [true, true]
  for (const source of terminalSources) lateAttempt(record, source, query)
  expect(query).toHaveBeenCalledTimes(1)
  expect(record.retired).toBe(true)
  expect(JSON.stringify(result)).toBe(original)
  const delayed = settledPolicyRecord(), neverQuery = suppliedAbsentGroup()
  delayed.physicalReady = false
  const frozen = settleRecord(delayed, neverQuery), before = JSON.stringify(frozen)
  for (const source of terminalSources) lateAttempt(delayed, source, neverQuery)
  delayed.physicalReady = true // Disposal alone is not a new terminal source.
  for (const source of terminalSources) lateAttempt(delayed, source, neverQuery)
  expect(neverQuery).toHaveBeenCalledTimes(0)
  expect([delayed.retired, delayed.queryUsed]).toEqual([false, false])
  expect(JSON.stringify(frozen)).toBe(before)
})

async function withOwnedPreSpawnRoot(run: (root: string, restore: (cleanup: () => void) => void) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-git-public-test-')))
  const identity = fs.lstatSync(root, { bigint: true }), environment = { ...process.env }
  const cleanups: (() => void)[] = [], errors: unknown[] = []
  try {
    const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Unexpected owned spawn') })
    cleanups.push(() => spawn.mockRestore())
    const signal = spyOn(process, 'kill').mockImplementation(() => { throw new Error('Unexpected process query/signal') })
    cleanups.push(() => signal.mockRestore())
    await run(root, cleanup => cleanups.push(cleanup))
    expect(spawn).toHaveBeenCalledTimes(0)
    expect(signal).toHaveBeenCalledTimes(0)
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(environment).sort())
    expect(Object.entries(environment).every(([key, value]) => process.env[key] === value)).toBe(true)
  } catch (error) { errors.push(error) }
  finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch (error) { errors.push(error) } }
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(environment, key)) delete process.env[key]
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      const current = fs.lstatSync(root, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('Refusing teardown of an unowned public-test root')
      }
      fs.rmSync(root, { recursive: true, force: false })
    } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Public assertion or owned teardown failed', { cause: errors[0] })
}

test('owned public pre-spawn unavailable executable retires locally with frozen isolated snapshots', async () => {
  await withOwnedPreSpawnRoot(async (root, restore) => {
    const which = spyOn(Bun, 'which').mockReturnValue(null)
    restore(() => which.mockRestore())
    const context = createOwnedGitContext(), independent = createOwnedGitContext()
    const before = context.retainedRecords
    const result = await runGitAsync(['rev-parse', 'HEAD'], { cwd: root, ownedProcessGroup: context })
    expect(which).toHaveBeenCalledTimes(1)
    expect(which).toHaveBeenCalledWith('git', { cwd: root, PATH: process.env.PATH })
    expect(result).toEqual({
      ok: false, exitCode: null, stdout: '', stderr: '', cleanup: 'unknown',
      cleanupDetails: { outcome: 'failed', reason: 'executable', ownerJoined: false, captures: 'not-started', joinPending: false },
    })
    const after = context.retainedRecords
    expect(after).toEqual([])
    expect(after).not.toBe(before)
    expect(Object.isFrozen(after)).toBe(true)
    expect(Reflect.set(after, '0', {})).toBe(false)
    expect(independent.retainedRecords).toEqual([])
    expect(independent.retainedRecords).not.toBe(after)
  })
})

test('owned public pre-spawn adopts the actual S2 double-failure handle without spawning', async () => {
  await withOwnedPreSpawnRoot(async (root, restore) => {
    const temporary = spyOn(bootstrapOs, 'tmpdir').mockReturnValue(root)
    restore(() => temporary.mockRestore())
    const allocation = spyOn(bootstrapFs, 'mkdtempSync')
    restore(() => allocation.mockRestore())
    const setupError = new Error('injected bootstrap chmod failure'), disposalError = new Error('injected root removal failure')
    const nativeChmod = fs.chmodSync, nativeRemove = fs.rmSync, nativePrepare = startupModule.prepareAnchorStartup
    const setup = spyOn(bootstrapFs, 'chmodSync').mockImplementation((...args: Parameters<typeof fs.chmodSync>) => {
      const acquired = allocation.mock.results[0]?.value
      if (typeof acquired === 'string' && args[0] === acquired) {
        expect(args).toEqual([acquired, 0o700])
        throw setupError
      }
      return nativeChmod(...args)
    })
    restore(() => setup.mockRestore())
    let removalFault = true, observed: unknown
    const removal = spyOn(bootstrapFs, 'rmSync').mockImplementation((...args: Parameters<typeof fs.rmSync>) => {
      const acquired = allocation.mock.results[0]?.value
      if (typeof acquired === 'string' && args[0] === acquired) {
        expect(args).toEqual([acquired, { recursive: true, force: false }])
        if (removalFault) throw disposalError
      }
      return nativeRemove(...args)
    })
    restore(() => removal.mockRestore())
    const prepare = spyOn(startupModule, 'prepareAnchorStartup').mockImplementation(() => {
      try { return nativePrepare() } catch (error) { observed = error; throw error }
    })
    restore(() => prepare.mockRestore())
    const context = createOwnedGitContext(), independent = createOwnedGitContext()
    const result = await runGitAsync(['rev-parse', 'HEAD'], { cwd: root, ownedProcessGroup: context })
    expect([result.ok, result.exitCode, result.cleanup, result.cleanupDetails?.reason]).toEqual([false, null, 'unknown', 'startup'])
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(allocation).toHaveBeenCalledTimes(1)
    expect(allocation).toHaveBeenCalledWith(path.join(root, 'kawai-owned-git-'))
    expect(setup).toHaveBeenCalledTimes(1)
    expect(removal).toHaveBeenCalledTimes(1)
    if (!(observed instanceof AggregateError)) throw new Error('Expected the actual S2 AggregateError')
    expect(observed.errors).toHaveLength(2)
    expect(observed.errors[0]).toBe(setupError)
    expect(observed.errors[1]).toBe(disposalError)
    expect(observed.cause).toBe(setupError)
    const descriptor = Object.getOwnPropertyDescriptor(observed, 'startup'), retained: unknown = descriptor?.value
    expect([descriptor?.writable, descriptor?.enumerable, descriptor?.configurable]).toEqual([false, false, false])
    if (!retained || typeof retained !== 'object' || !('cwd' in retained) || typeof retained.cwd !== 'string'
      || !('dispose' in retained) || typeof retained.dispose !== 'function') throw new Error('Missing real startup handle')
    const acquired = allocation.mock.results[0]?.value
    if (typeof acquired !== 'string') throw new Error('Expected one string root from actual mkdtemp')
    expect(retained.cwd).toBe(acquired)
    expect(path.dirname(acquired)).toBe(root)
    expect(fs.existsSync(acquired)).toBe(true)
    const first = context.retainedRecords, second = context.retainedRecords
    expect(first).toHaveLength(1)
    expect(first[0]).toEqual({
      phase: 'settled', pid: null, queryUsed: false, joined: false, rootPending: true,
      cleanup: { outcome: 'failed', reason: 'startup', ownerJoined: false, captures: 'not-started', joinPending: false },
    })
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(Object.isFrozen(first[0]?.cleanup)).toBe(true)
    expect(independent.retainedRecords).toEqual([]) // Isolation, never recovery of the original.
    const dispose = retained.dispose
    removalFault = false
    retained.dispose()
    expect(retained.dispose).toBe(dispose)
    expect(Object.getOwnPropertyDescriptor(observed, 'startup')?.value).toBe(retained)
    expect(removal).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(acquired)).toBe(false) // Actual handle disposal, before fixture teardown.
    expect(fs.readdirSync(root)).toEqual([])
    expect(context.retainedRecords[0]?.rootPending).toBe(true) // No invented logical retirement.
  })
})
