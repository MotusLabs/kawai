import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuleRegistry } from '../team/routing/ruleLoader'
import { RuleTimeoutError } from '../team/routing/ruleHost'
import type { RouteContext } from '../../shared/routing'

const CTX: RouteContext = {
  now: '2026-10-12T12:00:00.000Z',
  group: { id: 'devs', profiles: [], max: 1, live: 0, strategy: 'first-available' },
  message: { id: 'm1', priority: 'normal', senderGroup: null, tags: ['x'], worktree: null, taskId: null },
  candidates: [{ id: 'member:a', kind: 'member', profileId: 'glm', providerId: 'zai', sessionId: 'a', cwd: '/r' }],
  profiles: {},
  providers: { zai: { label: 'Z.AI', profiles: ['glm'], usage: null, limitEvents: [], cooldownUntil: null } },
}

/**
 * The rejection of a rule call. Bun's `expect(promise).rejects` does not pump
 * Worker messages while it waits, so a Worker reply would never arrive.
 */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to fail')
}

describe('RuleRegistry', () => {
  let root: string
  let home: string
  let registry: RuleRegistry | null = null
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-rules-'))
    home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.kawai', 'routing'), { recursive: true })
  })
  afterEach(() => {
    registry?.close()
    registry = null
    fs.rmSync(root, { recursive: true, force: true })
  })

  const write = (name: string, body: string) => fs.writeFileSync(path.join(home, '.kawai', 'routing', name), body)
  const open = (env: Record<string, string> = {}) => (registry = new RuleRegistry({ homeDir: home, env }))

  test('loads a valid rule, publishes the types, and routes by it', async () => {
    write('devs.ts', `import type { RoutingRule } from './kawai-routing'
const rule: RoutingRule = { route: ctx => ({ type: 'pick', candidateId: ctx.candidates[0]!.id }) }
export default rule`)
    const report = await open().reload()
    expect(report.rules).toMatchObject([{ groupId: 'devs', ok: true, change: 'added', env: [] }])
    expect(fs.existsSync(path.join(home, '.kawai', 'routing', 'kawai-routing.d.ts'))).toBe(true)
    expect(await registry!.rule('devs')!.route(CTX)).toEqual({ type: 'pick', candidateId: 'member:a' })
  })

  test('a syntax error, a missing route, and a bad file name are reported; nothing loads for them', async () => {
    write('broken.ts', 'export default { route( => }')
    write('noroute.ts', 'export default { env: [] }')
    write('Bad Name.ts', 'export default { route: () => ({ type: "default" }) }')
    const report = await open().reload()
    const byId = Object.fromEntries(report.rules.map(rule => [rule.groupId, rule]))
    expect(byId.broken).toMatchObject({ ok: false })
    // The individual build errors are named, not just counted.
    expect(byId.broken!.error!.split(': ').length).toBeGreaterThan(1)
    expect(byId.noroute).toMatchObject({ ok: false, error: 'the rule must have a route function' })
    expect(byId['Bad Name']).toMatchObject({ ok: false })
    expect(registry!.rule('broken')).toBeUndefined()
    expect(registry!.rule('noroute')).toBeUndefined()
  })

  test('project-level rule files are never loaded', async () => {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, '.kawai', 'routing'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'routing', 'devs.ts'), 'export default { route: () => ({ type: "default" }) }')
    const report = await open().reload()
    expect(report.rules).toEqual([])
    expect(registry!.rule('devs')).toBeUndefined()
  })

  test('only declared variables reach the rule', async () => {
    write('devs.ts', `export default {
  env: ['GLM_API_KEY'],
  route: () => ({ type: 'hold', reason: JSON.stringify({ key: process.env.GLM_API_KEY ?? null, token: process.env.ANTHROPIC_AUTH_TOKEN ?? null, keys: Object.keys(process.env) }) }),
}`)
    await open({ GLM_API_KEY: 'glm-secret', ANTHROPIC_AUTH_TOKEN: 'hidden' }).reload()
    const decision = await registry!.rule('devs')!.route(CTX)
    if (decision.type !== 'hold') throw new Error('expected hold')
    expect(JSON.parse(decision.reason)).toEqual({ key: 'glm-secret', token: null, keys: ['GLM_API_KEY'] })
  })

  test('the bootstrap import sees an empty environment', async () => {
    write('devs.ts', `const seen = Object.keys(process.env).length
export default { env: ['A'], route: () => ({ type: 'hold', reason: String(seen) }) }`)
    await open({ A: '1' }).reload()
    // The serving Worker's own import sees its one declared variable.
    expect(await registry!.rule('devs')!.route(CTX)).toEqual({ type: 'hold', reason: '1' })
  })

  test('async rules, kept module state, throws, and invalid decisions', async () => {
    write('devs.ts', `let calls = 0
export default {
  async route(ctx) {
    calls++
    if (ctx.message.tags.includes('throw')) throw new Error('nope')
    if (ctx.message.tags.includes('bad')) return { type: 'teleport' }
    await new Promise(resolve => setTimeout(resolve, 5))
    return { type: 'hold', reason: String(calls), retryAfterMs: 600000 }
  },
}`)
    await open().reload()
    const host = registry!.rule('devs')!
    expect(await host.route(CTX)).toEqual({ type: 'hold', reason: '1', retryAfterMs: 600000 })
    expect(await host.route(CTX)).toEqual({ type: 'hold', reason: '2', retryAfterMs: 600000 })
    expect((await failure(host.route({ ...CTX, message: { ...CTX.message, tags: ['throw'] } }))).message).toBe('nope')
    expect((await failure(host.route({ ...CTX, message: { ...CTX.message, tags: ['bad'] } }))).message).toContain('invalid decision')
    expect(await host.route(CTX)).toEqual({ type: 'hold', reason: '5', retryAfterMs: 600000 })
    expect(host.hasOnLimit).toBe(false)
  })

  test('a hanging rule times out and is restarted after repeated timeouts', async () => {
    write('devs.ts', `let calls = 0
export default {
  timeoutMs: 50,
  route(ctx) {
    calls++
    if (ctx.message.tags.includes('spin')) { const end = Date.now() + 400; while (Date.now() < end) {} }
    return { type: 'hold', reason: String(calls) }
  },
}`)
    await open().reload()
    const host = registry!.rule('devs')!
    expect(host.timeoutMs).toBe(50)
    const spin = { ...CTX, message: { ...CTX.message, tags: ['spin'] } }
    for (let i = 0; i < 3; i++) expect(await failure(host.route(spin))).toBeInstanceOf(RuleTimeoutError)
    await Bun.sleep(100)
    // A fresh Worker: module state starts over.
    expect(await host.route(CTX)).toEqual({ type: 'hold', reason: '1' })
  })

  test('timeouts are capped at 10 s', async () => {
    write('devs.ts', 'export default { timeoutMs: 60000, route: () => ({ type: "default" }) }')
    await open().reload()
    expect(registry!.rule('devs')!.timeoutMs).toBe(10_000)
  })

  test('a rule reads the message\'s worker choice, and the published types carry it (dispatch-worker-choice 2.6)', async () => {
    write('devs.ts', `import type { RoutingRule } from './kawai-routing'
const rule: RoutingRule = {
  route: ctx => ctx.message.worker === 'zai' ? { type: 'pick', candidateId: ctx.candidates[0]!.id } : { type: 'default' },
  onLimit: e => e.message.worker ? { type: 'release' } : { type: 'park' },
}
export default rule`)
    await open().reload()
    const host = registry!.rule('devs')!
    expect(await host.route({ ...CTX, message: { ...CTX.message, worker: 'zai' } })).toEqual({ type: 'pick', candidateId: 'member:a' })
    expect(await host.route(CTX)).toEqual({ type: 'default' })
    const event = {
      now: CTX.now, profileId: 'glm', providerId: 'zai', sessionId: 'a', groupId: 'devs', message: { ...CTX.message, worker: 'zai/glm' },
      kind: 'rate_limit', status: 429, error: null, resetsAt: null, progress: { toolCalls: 0, filesTouched: [] }, parkCount: 0,
    }
    expect(await host.onLimit(event)).toEqual({ type: 'release' })
    expect(await host.onLimit({ ...event, message: CTX.message })).toEqual({ type: 'park' })
    const published = fs.readFileSync(path.join(home, '.kawai', 'routing', 'kawai-routing.d.ts'), 'utf8')
    expect(published).toBe(fs.readFileSync(path.resolve(import.meta.dir, '../../shared/routing.ts'), 'utf8'))
    expect(published).toMatch(/interface RouteMessage \{[^}]*\n {2}worker\?: string\n\}/)
  })

  test('onLimit is called and validated', async () => {
    write('devs.ts', `export default {
  route: () => ({ type: 'default' }),
  onLimit: e => e.progress.toolCalls > 0 ? { type: 'forward', to: { kind: 'group', id: 'architects' } } : { type: 'release' },
}`)
    await open().reload()
    const host = registry!.rule('devs')!
    expect(host.hasOnLimit).toBe(true)
    const event = {
      now: CTX.now, profileId: 'glm', providerId: 'zai', sessionId: 'a', groupId: 'devs', message: CTX.message, kind: 'rate_limit',
      status: 429, error: null, resetsAt: null, progress: { toolCalls: 2, filesTouched: [] }, parkCount: 0,
    }
    expect(await host.onLimit(event)).toEqual({ type: 'forward', to: { kind: 'group', id: 'architects' } })
    expect(await host.onLimit({ ...event, progress: { toolCalls: 0, filesTouched: [] } })).toEqual({ type: 'release' })
  })

  test('edits apply only on reload, which reports what changed', async () => {
    write('devs.ts', 'export default { route: () => ({ type: "hold", reason: "v1" }) }')
    write('qa.ts', 'export default { route: () => ({ type: "default" }) }')
    await open().reload()
    write('devs.ts', 'export default { route: () => ({ type: "hold", reason: "v2" }) }')
    fs.rmSync(path.join(home, '.kawai', 'routing', 'qa.ts'))
    write('ops.ts', 'export default { route: () => ({ type: "default" }) }')
    expect(await registry!.rule('devs')!.route(CTX)).toEqual({ type: 'hold', reason: 'v1' })
    expect(registry!.rule('qa')).toBeDefined()

    const report = await registry!.reload()
    expect(report.rules.map(rule => [rule.groupId, rule.change])).toEqual([
      ['devs', 'changed'], ['ops', 'added'], ['qa', 'removed'],
    ])
    expect(await registry!.rule('devs')!.route(CTX)).toEqual({ type: 'hold', reason: 'v2' })
    expect(registry!.rule('qa')).toBeUndefined()
    expect(registry!.lastReport()).toBe(report)
  })

  test('closing during a load leaves no rule running', async () => {
    write('devs.ts', 'export default { route: () => ({ type: "default" }) }')
    const loading = open().reload()
    registry!.close()
    await loading
    expect(registry!.rule('devs')).toBeUndefined()
  })

  test('the documented example rule loads and routes', async () => {
    fs.copyFileSync(path.resolve(import.meta.dir, '../../../docs/routing/devs.example.ts'), path.join(home, '.kawai', 'routing', 'devs.ts'))
    const report = await open().reload()
    expect(report.rules).toMatchObject([{ groupId: 'devs', ok: true }])
    const host = registry!.rule('devs')!
    expect(await host.route(CTX)).toEqual({ type: 'pick', candidateId: 'member:a' })
    const cooling = { ...CTX, profiles: { glm: { providerId: 'zai', usage: null, limitEvents: [], cooldownUntil: '2026-10-12T13:00:00.000Z' } } }
    expect(await host.route(cooling)).toMatchObject({ type: 'hold', retryAfterMs: 600_000 })
    // An earlier rule reads only candidates and per-profile entries, so the
    // additive provider view (D14) never changes its outcome.
    const withProvider = { ...cooling, providers: { zai: { label: 'Z.AI', profiles: ['glm'], usage: null, limitEvents: [], cooldownUntil: '2026-10-12T13:00:00.000Z' } } }
    expect(await host.route(withProvider)).toMatchObject({ type: 'hold', retryAfterMs: 600_000 })
    expect(host.hasOnLimit).toBe(true)
  })

  test('no routing directory is an empty report', async () => {
    fs.rmSync(path.join(home, '.kawai', 'routing'), { recursive: true })
    expect((await open().reload()).rules).toEqual([])
  })
  test('a zero-delay hold retains its retry time', async () => {
    write('devs.ts', "export default { route: () => ({ type: 'hold', reason: 'yield', retryAfterMs: 0 }) }")
    await open().reload()
    expect(await registry!.rule('devs')!.route(CTX)).toEqual({ type: 'hold', reason: 'yield', retryAfterMs: 0 })
  })

  test.each(['-1', 'NaN', 'Infinity', "'soon'"])('invalid retry delay %s rejects instead of creating an indefinite hold', async value => {
    write('devs.ts', `export default { route: () => ({ type: 'hold', reason: 'yield', retryAfterMs: ${value} }) }`)
    await open().reload()
    expect((await failure(registry!.rule('devs')!.route(CTX))).message).toContain('finite non-negative')
  })

})
