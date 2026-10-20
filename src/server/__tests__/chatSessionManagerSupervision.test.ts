// The manager's supervision wiring (plan-supervision D11, 8.2): the real boot
// starts the composed monitor only once the execution runtime's start has
// ended (D14 recovery first), and shutdown stops it after the runtime.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { ExecutionRuntime } from '../plans/execution/executionRuntime'
import { SupervisionMonitor } from '../plans/supervision/SupervisionMonitor'
import { SessionRegistry } from '../SessionRegistry'

let tempDir: string
let db: SessionDatabase
const spies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-manager-supervision-'))
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
})
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('the manager starts the supervision monitor after the execution runtime has started, and stops it at shutdown', async () => {
  const calls: string[] = []
  const runtimeStart = ExecutionRuntime.prototype.start
  const runtimeStop = ExecutionRuntime.prototype.stop
  const monitorStart = SupervisionMonitor.prototype.start
  const monitorStop = SupervisionMonitor.prototype.stop
  spies.push(
    spyOn(ExecutionRuntime.prototype, 'start').mockImplementation(async function (this: ExecutionRuntime) {
      calls.push('runtime.start:begin')
      await runtimeStart.call(this)
      await Bun.sleep(5)
      calls.push('runtime.start:end')
    }),
    spyOn(ExecutionRuntime.prototype, 'stop').mockImplementation(function (this: ExecutionRuntime) {
      calls.push('runtime.stop')
      runtimeStop.call(this)
    }),
    spyOn(SupervisionMonitor.prototype, 'start').mockImplementation(function (this: SupervisionMonitor) {
      calls.push('monitor.start')
      monitorStart.call(this)
    }),
    spyOn(SupervisionMonitor.prototype, 'stop').mockImplementation(function (this: SupervisionMonitor) {
      calls.push('monitor.stop')
      monitorStop.call(this)
    }),
  )
  const manager = new ChatSessionManager({
    db, registry: new SessionRegistry(), onEvent: () => {}, isDirectory: () => true, profileCatalogHome: tempDir,
    providerUsageFetch: (async () => { throw new Error('no provider pulls') }) as unknown as typeof fetch,
  })
  await manager.whenRestored()
  expect(calls).toEqual(['runtime.start:begin', 'runtime.start:end', 'monitor.start'])
  manager.shutdown()
  expect(calls.slice(3)).toEqual(['runtime.stop', 'monitor.stop'])
})
