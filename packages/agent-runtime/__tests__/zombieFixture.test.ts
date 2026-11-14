// Real shell/pipe controls for the zombie fixture's setup and cleanup.
// The reaped control forces a permitted old ordering, not the historic CI schedule.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { liveGroupMembers } from '../src/process/processGroup.js'
import { ownedAggregate } from './helpers/ownedCleanup.js'
import { parseHelperPid, processIdentity, ZombieFixture, type FixtureMode, type StatReader } from './helpers/zombieFixture.js'

const assertedCleanupFailures = new Map<ZombieFixture, unknown>()
const owned = ownedAggregate<ZombieFixture, void>({
  join: (fixture) => fixture.cleanup(),
  failures: (fixture, outcome) => outcome.status === 'rejected' && (!assertedCleanupFailures.has(fixture) || assertedCleanupFailures.get(fixture) !== outcome.reason) ? [outcome.reason] : [],
  message: 'zombie control cleanups failed',
})
afterEach(() => owned.join())

function create(mode: FixtureMode = 'gated', read?: StatReader): ZombieFixture {
  const fixture = new ZombieFixture(mode, read)
  owned.add(fixture)
  return fixture
}

test('the shared validator immediately rejects the shell held before exec', async () => {
  const fixture = create('preexec')
  await fixture.setup(false)
  expect(() => fixture.validateReady()).toThrow("leader not exec'd")
  await fixture.cleanup()
  await fixture.execGateClosed
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})

test('stat disappearance is limited to ENOENT and ESRCH; other read errors fail closed', () => {
  for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EIO']) {
    const error = Object.assign(new Error(code), { code })
    const read = (path: string, encoding: 'utf8'): string => {
      expect([path, encoding]).toEqual(['/proc/4242/stat', 'utf8'])
      throw error
    }
    if (code === 'ENOENT' || code === 'ESRCH') expect(processIdentity(4242, read)).toBeNull()
    else expect(() => processIdentity(4242, read)).toThrow(error)
  }
  expect(() => processIdentity(4242, (path, encoding) => {
    expect([path, encoding]).toEqual(['/proc/4242/stat', 'utf8'])
    return 'malformed'
  })).toThrow('invalid stat for owned pid 4242')
})

test('the shared PID parser accepts only one bounded positive safe PID distinct from the leader', () => {
  expect(parseHelperPid('123\n', 42)).toBe(123)
  for (const record of ['', '0\n', '-1\n', '1.5\n', '42\n', ' 123\n', '123 \n', '123', '123\n124\n', '9007199254740992\n', `${'1'.repeat(33)}\n`]) {
    expect(() => parseHelperPid(record, 42)).toThrow('invalid helper PID')
  }
})

test('malformed PID, EOF and failed exec reject setup and still join owned pipes', async () => {
  for (const [mode, message] of [['invalid-pid', /invalid helper PID record/], ['pid-eof', /helper PID EOF/], ['exec-failed', /exited|ENOENT|ESRCH|missing owned leader identity/]] as const) {
    const fixture = create(mode)
    await expect(fixture.setup()).rejects.toThrow(message)
    await fixture.cleanup()
    expect(fixture.didClose).toBe(true)
    await Promise.all([fixture.stdoutClosed, fixture.gateClosed, fixture.exited])
    expect(liveGroupMembers(fixture.leader)).toEqual([])
  }
})

test('PID and exec observation deadlines reject while owned cleanup remains joinable', async () => {
  for (const [mode, message] of [['pid-held', 'helper PID deadline'], ['preexec', "leader not exec'd before deadline"]] as const) {
    const fixture = create(mode)
    await expect(fixture.setup()).rejects.toThrow(message)
    await fixture.cleanup()
    expect(fixture.didClose).toBe(true)
    expect(liveGroupMembers(fixture.leader)).toEqual([])
  }
})

test('the shared validator rejects a child reaped before parent exec', async () => {
  const fixture = create('reaped')
  await fixture.setup() // parent wait has reaped the child; exec is observed
  expect(processIdentity(fixture.helper)).toBeNull()
  expect(() => fixture.validateReady()).toThrow('helper missing or nonlive before release')
  await fixture.cleanup()
  expect(fixture.didClose).toBe(true)
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})

test('cleanup joins a gated stdout-holding helper after its leader exits', async () => {
  const fixture = create()
  await fixture.setup()
  const before = fixture.validateReady()
  expect(fixture.child.kill('SIGKILL')).toBe(true)
  await fixture.exited
  expect(fixture.didClose).toBe(false) // helper still owns stdout and fd3
  expect(processIdentity(fixture.helper)?.start).toBe(before.start)
  expect(liveGroupMembers(fixture.leader)).toEqual([fixture.helper])
  const cleanup = fixture.cleanup()
  expect(fixture.cleanup()).toBe(cleanup)
  await cleanup
  expect(fixture.didClose).toBe(true)
  await Promise.all([fixture.closed, fixture.exited, fixture.gateClosed, fixture.stdoutClosed])
  expect(liveGroupMembers(fixture.leader)).toEqual([])
  expect(['Z', 'X', undefined]).toContain(processIdentity(fixture.helper)?.state)
})

test('cleanup signals the live pinned group before destroying its gate', async () => {
  const fixture = create()
  await fixture.setup()
  fixture.validateReady()
  fixture.child.kill('SIGKILL')
  await fixture.exited
  const events: string[] = []
  const observations: Array<[number, string | number | undefined, boolean, string | undefined]> = []
  const kill = process.kill.bind(process)
  const destroy = fixture.gate.destroy.bind(fixture.gate)
  const killSpy = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== -fixture.leader || signal !== 'SIGKILL') throw new Error('unexpected owned group signal')
    events.push('kill')
    observations.push([pid, signal, fixture.gate.destroyed, processIdentity(fixture.helper)?.state])
    return kill(pid, signal)
  })
  const destroySpy = spyOn(fixture.gate, 'destroy').mockImplementation((error) => {
    events.push('destroy')
    // An omission control must never actually release the ownership pin
    // before a group signal. Record that bad request, but retain the fd.
    return events.includes('kill') ? destroy(error) : fixture.gate
  })
  try {
    await fixture.cleanup()
  } finally { killSpy.mockRestore(); destroySpy.mockRestore(); destroy() }
  expect(events[0]).toBe('kill')
  expect(events).toContain('destroy')
  expect(observations).toHaveLength(1)
  const [pid, signal, destroyed, state] = observations[0]!
  expect([pid, signal, destroyed]).toEqual([-fixture.leader, 'SIGKILL', false])
  expect(state).toBeDefined()
  expect(['Z', 'X']).not.toContain(state)
})

test('unknown-helper cleanup cancels the PID reader and proves death through inherited stdout', async () => {
  const fixture = create('pid-held')
  const record = new Promise<number>((resolve) => fixture.child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString()))))
  const setup = fixture.setup().then(() => null, (error: Error) => error)
  const helper = await record // partial record is not yet accepted by the owner
  expect(Number.isSafeInteger(helper) && helper > 0 && helper !== fixture.leader).toBe(true)
  expect(processIdentity(helper)?.parent).toBe(fixture.leader)
  expect(fixture.helper).toBe(0)
  expect(fixture.didClose).toBe(false)
  const kills: number[] = []
  const kill = process.kill.bind(process)
  const spy = spyOn(process, 'kill').mockImplementation((pid, signal) => { kills.push(pid); return kill(pid, signal) })
  try { await fixture.cleanup() } finally { spy.mockRestore() }
  expect((await setup)?.message).toBe('helper PID read cancelled by cleanup')
  expect(kills).toEqual([]) // no invented group identity from a partial record
  expect(fixture.didClose).toBe(true)
  await Promise.all([fixture.stdoutClosed, fixture.gateClosed, fixture.execGateClosed, fixture.exited])
  const deadline = Date.now() + 5000
  while (true) {
    const identity = processIdentity(helper)
    if (!identity || ['Z', 'X'].includes(identity.state)) break
    if (Date.now() > deadline) throw new Error('unknown helper still live after stdout close')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  expect(['Z', 'X', undefined]).toContain(processIdentity(helper)?.state)
})

test('a gate write EPIPE rejects release and cleanup still joins the actual group', async () => {
  const fixture = create()
  await fixture.setup()
  const epipe = Object.assign(new Error('fixture gate EPIPE'), { code: 'EPIPE' })
  const write = spyOn(fixture.gate, 'write').mockImplementation((chunk: unknown, ...args: unknown[]) => {
    expect(chunk).toBe('\n')
    expect(args).toHaveLength(1)
    expect(typeof args[0]).toBe('function')
    const callback = args[0] as (error: Error) => void
    callback(epipe)
    return false
  })
  try { await expect(fixture.zombie()).rejects.toBe(epipe) } finally { write.mockRestore() }
  await fixture.cleanup()
  expect(fixture.didClose).toBe(true)
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})

test('cleanup never signals a released group after observing leader exit', async () => {
  const fixture = create()
  await fixture.setup()
  await fixture.zombie()
  fixture.child.kill('SIGKILL')
  await fixture.exited
  const kills: number[] = []
  const kill = process.kill.bind(process)
  const spy = spyOn(process, 'kill').mockImplementation((pid, signal) => { kills.push(pid); return kill(pid, signal) })
  try { await fixture.cleanup() } finally { spy.mockRestore() }
  expect(kills).toEqual([])
  expect(fixture.didClose).toBe(true)
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})

test('cleanup aggregates failed joins after attempting the remaining real pipe and death joins', async () => {
  const fixture = create()
  await fixture.setup()
  fixture.validateReady()
  const actualExit = fixture.exited
  const actualClose = fixture.closed
  const exitError = new Error('injected exit join failure')
  const closeError = new Error('injected close join failure')
  Object.defineProperty(fixture, 'exited', { value: Promise.reject(exitError) })
  Object.defineProperty(fixture, 'closed', { value: Promise.reject(closeError) })
  const cleanup = fixture.cleanup()
  const error = await cleanup.then(() => null, (caught: unknown) => caught)
  assertedCleanupFailures.set(fixture, error)
  await Promise.all([actualExit, actualClose, fixture.gateClosed, fixture.stdoutClosed])
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toEqual([exitError, closeError])
  expect(fixture.cleanup()).toBe(cleanup)
  expect(fixture.didClose).toBe(true)
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})

test('cleanup retains a proc read failure but still terminates only the directly owned child', async () => {
  const denied = Object.assign(new Error('owned helper stat denied'), { code: 'EACCES' })
  let fail = false
  let fixture: ZombieFixture
  fixture = create('gated', (path, encoding) => {
    expect(encoding).toBe('utf8')
    expect([`/proc/${fixture.leader}/stat`, `/proc/${fixture.helper}/stat`]).toContain(path)
    if (fail && path === `/proc/${fixture.helper}/stat`) { fail = false; throw denied }
    return readFileSync(path, encoding)
  })
  await fixture.setup()
  fixture.validateReady()
  fail = true
  const signals: number[] = []
  const kill = process.kill.bind(process)
  const spy = spyOn(process, 'kill').mockImplementation((pid, signal) => { signals.push(pid); return kill(pid, signal) })
  let error: unknown
  try { error = await fixture.cleanup().then(() => null, (caught: unknown) => caught) } finally { spy.mockRestore() }
  assertedCleanupFailures.set(fixture, error)
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toEqual([denied])
  expect(signals).toEqual([])
  expect(fixture.didClose).toBe(true)
  await Promise.all([fixture.closed, fixture.exited, fixture.gateClosed, fixture.stdoutClosed])
  expect(liveGroupMembers(fixture.leader)).toEqual([])
})
