// @reads: packages/agent-runtime/README.md, packages/agent-runtime/examples/**, packages/agent-runtime/__tests__/fixtures/**
// The README's headless Codex example (task 4.2/4.4/4.5 docs): the README
// block is byte-for-byte examples/headless-codex.ts, which the package
// typecheck compiles, and this test runs that file unchanged over the owned
// fake app-server: no login builds no driver, a fresh host saves the thread
// id before start() resolves, and a second driver with the same homes
// resumes that thread under the example's read-only policy. The fake login
// is a sample value built at runtime; no credentials.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexAgentDriver, ResumeCheckpoint } from '../src/contract.js'
import { headlessCodex, type CheckpointStore } from '../examples/headless-codex.js'
import { codexRoot, sent } from './helpers/codexDriverHarness.js'

const PACKAGE_DIR = join(import.meta.dir, '..')
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const drivers: CodexAgentDriver[] = []
afterEach(async () => {
  await Promise.allSettled(drivers.splice(0).map((driver) => driver.kill()))
})

function readmeBlock(file: string): string {
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8')
  const marker = `<!-- example: ${file} -->\n\`\`\`ts\n`
  const start = readme.indexOf(marker)
  if (start < 0) throw new Error(`README has no block for ${file}`)
  const body = start + marker.length
  return readme.slice(body, readme.indexOf('\n```\n', body) + 1)
}

function memoryStore(): CheckpointStore & { saved: ResumeCheckpoint[]; persisted: boolean } {
  const store = {
    saved: [] as ResumeCheckpoint[],
    persisted: false,
    load: () => store.saved.at(-1) ?? null,
    save: async (checkpoint: ResumeCheckpoint) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      store.saved.push(checkpoint)
      store.persisted = true
    },
  }
  return store
}

describe('README: a headless Codex host', () => {
  test('the README block is exactly examples/headless-codex.ts', () => {
    expect(readmeBlock('examples/headless-codex.ts')).toBe(readFileSync(join(PACKAGE_DIR, 'examples/headless-codex.ts'), 'utf8'))
  })

  test('the example builds nothing without a login, saves the thread before ready, and a second driver resumes it', async () => {
    const root = codexRoot()
    const store = memoryStore()
    expect(headlessCodex(root.launch(), logger, store)).toBeNull()
    writeFileSync(join(root.home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: ['sample', 'key'].join('-') }))
    const first = headlessCodex(root.launch(), logger, store)!
    drivers.push(first)
    await first.start()
    expect(store.persisted).toBe(true)
    expect((await (await first.send('marker')).result).finalText).toBe('codex:rekram|seen=')
    await first.shutdown()
    const second = headlessCodex(root.launch(), logger, store)!
    drivers.push(second)
    await second.start()
    expect((await (await second.send('recall')).result).finalText).toBe('codex:llacer|seen=marker')
    expect(store.saved).toHaveLength(1)
    expect(sent(root, 'thread/resume')[0]!.params).toMatchObject({ threadId: store.saved[0]!.runtimeSessionId, sandbox: 'read-only', approvalPolicy: 'never' })
  })
})
