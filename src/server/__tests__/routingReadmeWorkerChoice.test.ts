// The routing README's worker-choice example (dispatch-worker-choice 2.7)
// matches the rule types: it type-checks against the published contract
// (`src/shared/routing.ts`, copied verbatim as `kawai-routing.d.ts`), loads
// through the real rule registry, and behaves as the prose says.
// @reads: docs/routing/README.md
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { RuleRegistry } from '../team/routing/ruleLoader'
import type { LimitOutcomeContext, RouteContext } from '../../shared/routing'

const README = path.resolve(import.meta.dir, '../../../docs/routing/README.md')
const CONTRACT = path.resolve(import.meta.dir, '../../shared/routing.ts')

function example(): string {
  const block = /## Worker choice[\s\S]*?```ts\n([\s\S]*?)```/.exec(fs.readFileSync(README, 'utf8'))?.[1]
  if (!block) throw new Error('no worker-choice example in the routing README')
  return block
}

/** Type diagnostics of `source` beside the contract as `kawai-routing.ts`, strict. */
function typeErrors(dir: string, source: string): string[] {
  fs.writeFileSync(path.join(dir, 'kawai-routing.ts'), fs.readFileSync(CONTRACT, 'utf8'))
  fs.writeFileSync(path.join(dir, 'devs.ts'), source)
  const program = ts.createProgram([path.join(dir, 'devs.ts')], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ['lib.es2022.d.ts'],
  })
  return ts.getPreEmitDiagnostics(program).map(entry => ts.flattenDiagnosticMessageText(entry.messageText, '\n'))
}

const CTX: RouteContext = {
  now: '2026-10-12T12:00:00.000Z',
  group: { id: 'devs', profiles: [], max: 2, live: 0, strategy: 'first-available' },
  message: { id: 'm1', priority: 'normal', senderGroup: null, tags: [], worktree: null, taskId: null, worker: 'zai' },
  candidates: [
    { id: 'spawn:glm', kind: 'spawn', profileId: 'glm', providerId: 'zai', cwd: '/r' },
    { id: 'member:a', kind: 'member', profileId: 'glm', providerId: 'zai', sessionId: 'a', cwd: '/r' },
  ],
  profiles: {},
  providers: {},
}

describe('the routing README worker-choice example (2.7)', () => {
  let root: string
  let registry: RuleRegistry | null = null
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-readme-rule-')) })
  afterEach(() => { registry?.close(); registry = null; fs.rmSync(root, { recursive: true, force: true }) })

  test('type-checks against the rule contract, and a wrong field would not', () => {
    expect(typeErrors(root, example())).toEqual([])
    // Non-vacuity: the same check refuses a field the contract lacks.
    expect(typeErrors(root, example().replace('ctx.message.worker', 'ctx.message.workerChoice')).length).toBeGreaterThan(0)
  })

  test('loads through the rule registry and routes and limits as described', async () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.kawai', 'routing'), { recursive: true })
    fs.writeFileSync(path.join(home, '.kawai', 'routing', 'devs.ts'), example())
    registry = new RuleRegistry({ homeDir: home, env: {} })
    expect((await registry.reload()).rules).toMatchObject([{ groupId: 'devs', ok: true }])
    const host = registry.rule('devs')!
    expect(await host.route(CTX)).toEqual({ type: 'pick', candidateId: 'member:a' })
    const { worker: _worker, ...unpinned } = CTX.message
    expect(await host.route({ ...CTX, message: unpinned })).toEqual({ type: 'default' })
    const event: LimitOutcomeContext = {
      now: CTX.now, profileId: 'glm', providerId: 'zai', sessionId: 'a', groupId: 'devs', message: CTX.message,
      kind: 'rate_limit', status: 429, error: null, resetsAt: null, progress: { toolCalls: 1, filesTouched: [] }, parkCount: 0,
    }
    expect(await host.onLimit(event)).toEqual({ type: 'release' })
    expect(await host.onLimit({ ...event, message: unpinned })).toEqual({ type: 'default' })
  })
})
