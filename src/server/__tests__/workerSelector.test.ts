// Worker selectors (dispatch-worker-choice D1, task 1.2): normalization
// against the catalog, every D1 case, the agent-mailbox refusals the selector
// decides (unknown, ambiguous, outside the group), and resolution to the
// group's model keys at route time.
import { describe, expect, test } from 'bun:test'
import {
  normalizeWorkerSelector, resolveWorkerSelector, validateWorkerChoice, type WorkerCatalog,
} from '../team/routing/workerSelector'

// zai owns glm and glm-flash; claude owns sonnet and opus; `mimo` is a
// one-model provider whose model shares its id; `claude` is also a model key
// of the `proxy` provider (the ambiguous case).
const catalog: WorkerCatalog = new Map([
  ['glm', 'zai'], ['glm-flash', 'zai'], ['sonnet', 'claude'], ['opus', 'claude'], ['mimo', 'mimo'], ['claude', 'proxy'],
])
const providerOf = (id: string) => catalog.get(id) ?? id

describe('normalizeWorkerSelector', () => {
  test('a provider stays a provider', () => {
    expect(normalizeWorkerSelector('zai', catalog)).toEqual({ ok: true, selector: 'zai' })
  })

  test('provider/model stays as written when that provider owns the model', () => {
    expect(normalizeWorkerSelector('zai/glm-flash', catalog)).toEqual({ ok: true, selector: 'zai/glm-flash' })
  })

  test('a bare model key is stored as provider/model', () => {
    expect(normalizeWorkerSelector('glm-flash', catalog)).toEqual({ ok: true, selector: 'zai/glm-flash' })
    expect(normalizeWorkerSelector('  sonnet ', catalog)).toEqual({ ok: true, selector: 'claude/sonnet' })
  })

  test('a one-model provider whose model shares its id is not ambiguous', () => {
    expect(normalizeWorkerSelector('mimo', catalog)).toEqual({ ok: true, selector: 'mimo' })
  })

  test('a bare id that is a provider and a model of another provider is refused asking for provider/model', () => {
    const result = normalizeWorkerSelector('claude', catalog)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'ambiguous' })
    expect(!result.ok && result.error).toContain('use the provider/model form (proxy/claude)')
    // Either qualified form is accepted.
    expect(normalizeWorkerSelector('proxy/claude', catalog)).toEqual({ ok: true, selector: 'proxy/claude' })
  })

  test('an id naming neither a provider nor a model is refused naming the catalog', () => {
    const result = normalizeWorkerSelector('gemini', catalog)
    expect(result).toMatchObject({ ok: false, reason: 'unknown' })
    expect(!result.ok && result.error).toContain('providers are claude, mimo, proxy, zai')
  })

  test('provider/model with a model of another provider is unknown', () => {
    expect(normalizeWorkerSelector('claude/glm', catalog)).toMatchObject({ ok: false, reason: 'unknown' })
  })

  test('malformed selectors are refused', () => {
    for (const raw of ['', '  ', 'zai/', '/glm', 'a/b/c']) {
      expect(normalizeWorkerSelector(raw, catalog)).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })
})

describe('resolveWorkerSelector', () => {
  const group = ['sonnet', 'glm-flash', 'opus', 'glm']

  test('a provider resolves to the models the group lists, in the group\'s order', () => {
    expect(resolveWorkerSelector('claude', group, providerOf)).toEqual(['sonnet', 'opus'])
    expect(resolveWorkerSelector('zai', group, providerOf)).toEqual(['glm-flash', 'glm'])
  })

  test('provider/model resolves to that model alone', () => {
    expect(resolveWorkerSelector('zai/glm-flash', group, providerOf)).toEqual(['glm-flash'])
  })

  test('a group edit after sending takes effect: a model the group no longer lists resolves to nothing', () => {
    expect(resolveWorkerSelector('zai/glm-flash', ['sonnet', 'glm'], providerOf)).toEqual([])
    expect(resolveWorkerSelector('mimo', group, providerOf)).toEqual([])
  })

  test('a catalog edit that re-homes the model drops it from the choice', () => {
    expect(resolveWorkerSelector('zai/glm', group, id => (id === 'glm' ? 'other' : providerOf(id)))).toEqual([])
  })
})

describe('validateWorkerChoice', () => {
  const devs = { id: 'middle-devs', profiles: ['glm', 'sonnet'] }

  test('a provider among the group\'s workers is accepted with its models', () => {
    expect(validateWorkerChoice('claude/sonnet', catalog, devs)).toEqual({ ok: true, selector: 'claude/sonnet', profiles: ['sonnet'] })
    expect(validateWorkerChoice('zai', catalog, devs)).toEqual({ ok: true, selector: 'zai', profiles: ['glm'] })
  })

  test('a worker the group does not list is refused naming the group\'s workers', () => {
    const result = validateWorkerChoice('opus', catalog, devs)
    expect(result).toMatchObject({ ok: false, reason: 'outside-group' })
    expect(!result.ok && result.error).toBe('Worker "claude/opus" is not among group middle-devs\'s workers: zai/glm, claude/sonnet.')
  })

  test('unknown and ambiguous ids are refused before the group check', () => {
    expect(validateWorkerChoice('gemini', catalog, devs)).toMatchObject({ ok: false, reason: 'unknown' })
    expect(validateWorkerChoice('claude', catalog, devs)).toMatchObject({ ok: false, reason: 'ambiguous' })
  })
})
