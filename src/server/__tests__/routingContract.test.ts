import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { RouteContext, RoutingRule } from '../../shared/routing'

const CONTRACT = path.resolve(import.meta.dir, '../../shared/routing.ts')

// Type-level check: a realistic rule against the published contract
// compiles under `bun run typecheck`.
const exampleRule: RoutingRule = {
  env: ['GLM_API_KEY'],
  timeoutMs: 2000,
  async route(ctx: RouteContext) {
    const fresh = ctx.candidates.filter(candidate => !ctx.profiles[candidate.profileId]?.cooldownUntil)
    const member = fresh.find(candidate => candidate.kind === 'member')
    if (member) return { type: 'pick', candidateId: member.id }
    if (fresh.length === 0) return { type: 'hold', reason: 'all cooling', retryAfterMs: 600_000 }
    return { type: 'default' }
  },
  onLimit(event) {
    return event.progress.toolCalls > 0 ? { type: 'forward', to: { kind: 'group', id: 'architects' } } : { type: 'release' }
  },
}

describe('routing contract', () => {
  test('is type-only, so it can be published verbatim as a .d.ts', () => {
    const source = fs.readFileSync(CONTRACT, 'utf8')
    expect(source).not.toMatch(/^import /m)
    const emitted = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
    // Only `export {}`-style residue may remain: no runtime statements.
    expect(emitted.replace(/export\s*\{\s*\};?/g, '').trim()).toBe('')
  })

  test('the example rule runs', async () => {
    const ctx = {
      now: '2026-10-12T12:00:00.000Z',
      group: { id: 'devs', profiles: [], max: 1, live: 0, strategy: 'first-available' },
      message: { id: 'm', priority: 'normal', senderGroup: null, tags: [], worktree: null, taskId: null },
      candidates: [{ id: 'spawn:glm', kind: 'spawn', profileId: 'glm', cwd: '/repo' }],
      profiles: { glm: { usage: null, limitEvents: [], cooldownUntil: '2026-10-12T13:00:00.000Z' } },
    } satisfies RouteContext
    expect(await exampleRule.route(ctx)).toEqual({ type: 'hold', reason: 'all cooling', retryAfterMs: 600_000 })
  })
})

describe('publishRuleTypes', () => {
  test('writes the contract once into an existing directory and skips a missing one', async () => {
    const { publishRuleTypes, RULE_TYPES_FILE } = await import('../team/routing/ruleTypes')
    const os = await import('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-rule-types-'))
    try {
      expect(publishRuleTypes(path.join(dir, 'missing'))).toBeNull()
      const target = publishRuleTypes(dir)!
      expect(target).toBe(path.join(dir, RULE_TYPES_FILE))
      expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(CONTRACT, 'utf8'))
      const before = fs.statSync(target).mtimeMs
      await Bun.sleep(5)
      publishRuleTypes(dir)
      expect(fs.statSync(target).mtimeMs).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
