// Shared setup for the Codex transport regressions: a real AppServerTransport
// over the owned fake app-server (fixtures/fakeAppServer.ts), with an isolated
// cwd and home per transport, a transcript of every line the child received,
// and cleanup that stops every transport a test left running.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerTransport, type AppServerTransportOptions } from '../../src/codex/appServerTransport.js'
import { resolveLaunch } from '../../src/process/launch.js'

export const FAKE_APP_SERVER = join(import.meta.dir, '..', 'fixtures', 'fakeAppServer.ts')
export const BUN = process.execPath
const live: AppServerTransport[] = []

export interface Fake {
  transport: AppServerTransport
  root: string
  /** The exact child environment the transport was given. */
  childEnv: Record<string, string>
  /** Every JSON line the child received, parsed. */
  received(): Record<string, any>[]
}

export function fake(overrides: Partial<AppServerTransportOptions> = {}, extraEnv: Record<string, string> = {}): Fake {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-codex-')))
  for (const dir of ['home', 'cache', 'tmp']) mkdirSync(join(root, dir))
  const transcript = join(root, 'transcript.jsonl')
  const childEnv = { FAKE_TRANSCRIPT: transcript, CODEX_HOME: join(root, 'home'), ...extraEnv }
  const launch = resolveLaunch({ cwd: root, childEnv, homeDir: join(root, 'home'), cacheDir: join(root, 'cache'), tempDir: join(root, 'tmp') })
  const transport = new AppServerTransport({
    launch,
    generation: 1,
    command: BUN,
    args: [FAKE_APP_SERVER],
    clientInfo: { name: 'agent-runtime-test', version: '0.0.0' },
    capabilities: { experimentalApi: true },
    terminate: { graceMs: 500, killMs: 2000 },
    ...overrides,
  })
  live.push(transport)
  const received = () => {
    let text = ''
    try {
      text = readFileSync(transcript, 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
  }
  return { transport, root, childEnv, received }
}

export async function stopAll(): Promise<void> {
  await Promise.allSettled(live.splice(0).map((transport) => transport.stop()))
}

export const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true, () => true), Bun.sleep(ms).then(() => false)])

/** The rejection of `promise`, failing when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}

export async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await Bun.sleep(5)
  }
}
