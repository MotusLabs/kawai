// The shared e2e server stop sequence (tests/e2e/fixtures/serverProcess.ts):
// SIGTERM, a bounded wait, SIGKILL, another bounded wait, then a failure
// naming the pid — and never a signal to a server that already exited (by
// code or by signal) or was never spawned. Each case spawns its own small
// bun child and kills only that child; every test carries an explicit
// timeout so a stuck child fails the case instead of the runner.
import { expect, spyOn, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { ServerProcess } from '../../../tests/e2e/fixtures/serverProcess'

const TERM_GRACE_MS = 1_500
const KILL_GRACE_MS = 10_000

/** A child that stays alive until signalled. */
function spawnSleeper(proc: ServerProcess): ChildProcess {
  return proc.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] })
}

/** A child that ignores SIGTERM, so only the SIGKILL escalation ends it.
 * Prints READY once the handler is installed: a SIGTERM sent earlier lands
 * on the default disposition and kills the child during startup. */
function spawnSigtermIgnorer(proc: ServerProcess): ChildProcess {
  return proc.spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Resolves when the child has run its script far enough to print READY. */
function onceReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', chunk => { if (String(chunk).includes('READY')) resolve() })
    child.once('exit', (code, signal) => reject(new Error(`child exited before READY: code=${code} signal=${signal}`)))
  })
}

function onceExited(child: ChildProcess): Promise<void> {
  return new Promise(resolve => { child.once('exit', () => resolve()) })
}

test('stop ends a live server on SIGTERM within the term grace', async () => {
  const proc = new ServerProcess()
  const child = spawnSleeper(proc)
  await proc.stop({ termGraceMs: TERM_GRACE_MS, killGraceMs: KILL_GRACE_MS })
  expect(child.signalCode).toBe('SIGTERM')
  expect(proc.running).toBe(false)
}, 15_000)

test('stop escalates to SIGKILL when the server ignores SIGTERM, and the pid is gone after', async () => {
  const proc = new ServerProcess()
  const child = spawnSigtermIgnorer(proc)
  await onceReady(child)
  await proc.stop({ termGraceMs: 500, killGraceMs: KILL_GRACE_MS })
  expect(child.signalCode).toBe('SIGKILL')
  // Gone means gone: signal 0 tests for the process without sending one.
  expect(() => process.kill(child.pid!, 0)).toThrow()
  expect(proc.running).toBe(false)
}, 15_000)

test('stop never signals a server that already exited by code', async () => {
  const proc = new ServerProcess()
  const child = proc.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'ignore'] })
  await onceExited(child)
  const kill = spyOn(child, 'kill')
  try {
    await proc.stop({ termGraceMs: TERM_GRACE_MS, killGraceMs: KILL_GRACE_MS })
    // Asserted before the finally restores the spy: mockRestore clears
    // mock.calls, so an assertion placed after it could never fail.
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
  }
  expect(proc.running).toBe(false)
}, 15_000)

test('stop never signals a server that already died to a signal', async () => {
  const proc = new ServerProcess()
  const child = spawnSleeper(proc)
  child.kill('SIGKILL')
  await onceExited(child)
  const kill = spyOn(child, 'kill')
  try {
    await proc.stop({ termGraceMs: TERM_GRACE_MS, killGraceMs: KILL_GRACE_MS })
    // Asserted before the finally restores the spy: mockRestore clears
    // mock.calls, so an assertion placed after it could never fail.
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
  }
  expect(proc.running).toBe(false)
}, 15_000)

test('stop resolves without signalling when nothing was ever spawned', async () => {
  const proc = new ServerProcess()
  await proc.stop({ termGraceMs: 100, killGraceMs: 100 })
  expect(proc.running).toBe(false)
  expect(proc.diagnostics()).toBe('')
}, 15_000)
