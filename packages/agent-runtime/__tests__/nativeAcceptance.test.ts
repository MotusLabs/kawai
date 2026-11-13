// Native probe guards only: this file never calls a model or reads credentials.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateIsolation, validateHostIsolation, privateError, verifyExit, runNativeProbe, type NativeInput } from '../examples/native-probe.js'
import type { ProcessExitReceipt } from '../src/contract.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function isolated(): NativeInput {
  const root = mkdtempSync(join(tmpdir(), 'native-guard-'))
  chmodSync(root, 0o700)
  roots.push(root)
  const dirs = Object.fromEntries(['cwd', 'home', 'provider', 'cache', 'temp', 'config', 'data', 'state'].map((key) => {
    const path = join(root, key)
    mkdirSync(path, { mode: 0o700 })
    return [key, path]
  }))
  return { root, runtime: 'claude', model: 'configured-model', launch: {
    cwd: dirs.cwd!, homeDir: dirs.provider!, cacheDir: dirs.cache!, tempDir: dirs.temp!, executablePath: '/cli',
    childEnv: { HOME: dirs.home!, CLAUDE_CONFIG_DIR: dirs.provider!, XDG_CACHE_HOME: dirs.cache!,
      XDG_CONFIG_HOME: dirs.config!, XDG_DATA_HOME: dirs.data!, XDG_STATE_HOME: dirs.state!, TMPDIR: dirs.temp! },
  } }
}

test('native probe accepts explicit non-root isolated homes for either runtime', () => {
  const input = isolated()
  expect(() => validateIsolation(input, 1000)).not.toThrow()
  input.runtime = 'codex'
  input.launch.childEnv = { ...input.launch.childEnv, CODEX_HOME: input.launch.homeDir }
  expect(() => validateIsolation(input, 1000)).not.toThrow()
})

test('native probe refuses root, public storage, missing paths and symlink escapes before launch', () => {
  const input = isolated()
  expect(() => validateIsolation(input, 0)).toThrow('non-root')
  chmodSync(input.root, 0o755)
  expect(() => validateIsolation(input, 1000)).toThrow('private')
  chmodSync(input.root, 0o700)
  for (const field of ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CACHE_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    for (const value of ['', '/', input.root, '../relative']) {
      const changed = { ...input, launch: { ...input.launch, childEnv: { ...input.launch.childEnv, [field]: value } } }
      expect(() => validateIsolation(changed, 1000)).toThrow()
    }
  }
  const link = join(input.root, 'escape')
  symlinkSync(tmpdir(), link)
  expect(() => validateIsolation({ ...input, launch: { ...input.launch, cwd: link } }, 1000)).toThrow('escapes')
})

test('native exit verification rejects absent receipts, signal-only acknowledgements and live owned pids', () => {
  const receipt: ProcessExitReceipt = { scope: 'agent-processes', mode: 'kill', js: 'settled', processes: [
    { generation: 1, state: 'exited', pid: 123, code: null, signal: 'SIGTERM', escalated: false, groupCleared: true },
  ] }
  const seen: number[] = []
  verifyExit(receipt, (pid) => { seen.push(pid); return false })
  expect(seen).toEqual([123])
  expect(() => verifyExit(receipt, () => true)).toThrow('not confirmed gone')
  expect(() => verifyExit({ ...receipt, processes: [] }, () => false)).toThrow('missing exit')
  expect(() => verifyExit({ ...receipt, processes: [{ generation: 1, state: 'never-started' }] }, () => false)).toThrow()
  expect(() => verifyExit({ ...receipt, processes: [{ ...receipt.processes[0]!, groupCleared: false }] } as ProcessExitReceipt, () => false)).toThrow()
})

test('importing the native acceptance host exposes inert functions without executing its CLI', async () => {
  const imported = await import('../examples/native-probe.js')
  expect(typeof imported.runNativeProbe).toBe('function')
  expect(typeof imported.validateIsolation).toBe('function')
})

test('native probe refuses ambient host authority before provider construction', async () => {
  const input = isolated()
  // Exercise the actual entry point: it must reject before constructing a provider.
  await expect(runNativeProbe(input)).rejects.toThrow('probe host cwd is not isolated')
  const host = { cwd: input.launch.cwd, env: { ...input.launch.childEnv } }
  expect(() => validateHostIsolation(input, host)).not.toThrow()
  expect(() => validateHostIsolation(input, { ...host, cwd: input.root })).toThrow('host cwd')
  for (const env of [{ ...host.env, HOME: input.root }, { ...host.env, AMBIENT_TOKEN: 'poison' }, {}]) {
    expect(() => validateHostIsolation(input, { ...host, env })).toThrow('host environment')
  }
})

test('native private errors retain labels, nested native facts and non-enumerable causes', () => {
  const native = Object.assign(new Error('native exit'), { facts: { pid: 123, code: 143, signal: null } })
  const failure = new Error('stop failed', { cause: { label: 'consume:1', error: native } })
  Object.assign(failure, { causes: [new AggregateError([native], 'peer failures')], category: 'stop' })
  const captured = privateError(failure) as Record<string, unknown>
  expect(captured).toMatchObject({ name: 'Error', message: 'stop failed', category: 'stop',
    cause: { label: 'consume:1', error: { message: 'native exit', facts: { pid: 123, code: 143, signal: null } } } })
  expect(JSON.stringify(captured)).toContain('peer failures')
  expect(JSON.stringify(captured)).toContain('circularReference')
})
