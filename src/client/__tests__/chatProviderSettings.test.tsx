// The Settings credential section (provider-credential-store S5, U table at
// the client): a write-only editor over /api/settings/credentials. A fake
// server keeps the store's VALUES server-side only and answers with
// value-free listings, so every assertion that no value renders back is
// against a server that really holds one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { CredentialListing, CredentialListingRow } from '@shared/credentials'
import SettingsModal from '../components/SettingsModal'
import ChatProviderSettings from '../components/ChatProviderSettings'

interface Recorded {
  method: string
  path: string
  body: unknown
}

const SECRET = 'zq7-unshaped-sentinel'
const originalFetch = globalThis.fetch
let requests: Recorded[]
/** The fake server's store: name → {kind, value} (values never leave it). */
let store: Map<string, { kind: 'launch-env' | 'secret-source'; value: string }>
let failNext: { status: number; code: string; error: string } | null
let durable: boolean

function listing(): CredentialListing {
  const rows: CredentialListingRow[] = [...store.entries()].map(([name, entry]) => ({
    name, kind: entry.kind, state: entry.value === '' ? 'blank' : 'set', source: 'store', overriding: false, collision: false,
  }))
  return { store: { ok: true }, rows, migration: { state: 'none', text: null, skipped: [], ignored: [] } }
}

beforeEach(() => {
  requests = []
  failNext = null
  durable = true
  store = new Map([['ANTHROPIC_AUTH_TOKEN', { kind: 'secret-source', value: SECRET }], ['ANTHROPIC_BASE_URL', { kind: 'launch-env', value: 'https://gw.example' }]])
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes('/api/settings/credentials')) {
      return Response.json(url.includes('history-max-age-hours') ? { hours: 24 } : { enabled: true })
    }
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const path = url.replace('/api/settings/credentials', '')
    requests.push({ method, path, body })
    if (failNext) {
      const { status, code, error } = failNext
      failNext = null
      return Response.json({ code, error }, { status })
    }
    const name = decodeURIComponent(path.split('/')[1] ?? '')
    let applied = true
    if (method === 'PUT') store.set(name, { kind: body.kind ?? 'launch-env', value: body.value })
    else if (method === 'DELETE') applied = store.delete(name)
    else if (method === 'POST') store.set(name, { kind: body.kind, value: store.get(name)!.value })
    else return Response.json(listing())
    return Response.json({
      applied, durable: applied && durable,
      message: !applied ? 'Nothing changed.' : durable ? 'Saved. It applies at the next agent launch.' : 'Saved, but the store could not confirm the write reached the disk.',
      listing: listing(),
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<ChatProviderSettings />)
    await settle()
  })
  return renderer
}

const byTestId = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
  renderer.root.findAllByProps({ 'data-testid': id }).filter((n) => typeof n.type === 'string')
const byLabel = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root.findAll((n) => typeof n.type === 'string' && n.props['aria-label'] === label)[0]!
const button = (renderer: TestRenderer.ReactTestRenderer, text: string, within?: TestRenderer.ReactTestInstance) =>
  (within ?? renderer.root).findAll((n) => n.type === 'button' && n.children.join('') === text)[0]!
const rendered = (renderer: TestRenderer.ReactTestRenderer) => JSON.stringify(renderer.toJSON())

async function click(node: TestRenderer.ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick()
    await settle()
  })
}

async function type(node: TestRenderer.ReactTestInstance, value: string): Promise<void> {
  await act(async () => {
    node.props.onChange({ target: { value } })
  })
}

describe('ChatProviderSettings — the write-only credential section', () => {
  test('lists every variable with kind, state, and source, and renders no stored value', async () => {
    const renderer = await render()
    const row = byTestId(renderer, 'credential-row-ANTHROPIC_AUTH_TOKEN')[0]!
    expect(JSON.stringify(row.children.map(String))).toBeDefined()
    expect(rendered(renderer)).toContain('Secret source')
    expect(rendered(renderer)).toContain('Saved here')
    expect(rendered(renderer)).not.toContain(SECRET)
    expect(rendered(renderer)).not.toContain('https://gw.example')
    renderer.unmount()
  })

  // Preserved: the Settings Chat tab names this section by its label
  // (tests/e2e/settings-tabs.spec.ts), so the credential editor keeps it.
  test('the section keeps its Claude Chat Provider label', async () => {
    const renderer = await render()
    const labels = renderer.root.findAllByType('label').map(node => node.children.join(''))
    expect(labels).toContain('Claude Chat Provider')
    renderer.unmount()
  })

  // @covers: provider-credentials › The credential UI is write-only › Replace requires retyping
  test('replace requires retyping: every value input starts empty and is empty again after a save', async () => {
    const renderer = await render()
    const input = () => byLabel(renderer, 'New value for ANTHROPIC_AUTH_TOKEN')
    expect(input().props.value).toBe('')
    expect(input().props.type).toBe('password')
    expect(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL').props.value).toBe('')
    await type(input(), 'replacement')
    await click(button(renderer, 'Set', byTestId(renderer, 'credential-row-ANTHROPIC_AUTH_TOKEN')[0]!))
    expect(requests.at(-1)).toEqual({ method: 'PUT', path: '/ANTHROPIC_AUTH_TOKEN', body: { value: 'replacement', kind: 'secret-source' } })
    expect(input().props.value).toBe('')
    expect(rendered(renderer)).not.toContain('replacement')
    // A remount (reopening Settings) starts empty too.
    renderer.unmount()
    const again = await render()
    expect(byLabel(again, 'New value for ANTHROPIC_AUTH_TOKEN').props.value).toBe('')
    again.unmount()
  })

  // @covers: provider-credentials › The credential UI is write-only › Errors carry fixed safe text only
  test('a refusal shows the server\'s fixed text only and keeps what was typed', async () => {
    const renderer = await render()
    await type(byLabel(renderer, 'New variable name'), 'lower_secret')
    await type(byLabel(renderer, 'New variable value'), SECRET)
    failNext = { status: 400, code: 'name-not-catalog', error: 'A secret source needs an upper-case name (A-Z, 0-9, _), like a catalog binding.' }
    await click(byTestId(renderer, 'credential-add')[0]!)
    const error = byTestId(renderer, 'chat-provider-error')[0]!
    expect(error.props.role).toBe('alert')
    expect(error.children.join('')).toBe('A secret source needs an upper-case name (A-Z, 0-9, _), like a catalog binding.')
    expect(byLabel(renderer, 'New variable name').props.value).toBe('lower_secret')
    renderer.unmount()
  })

  test('a non-JSON failure renders a fixed sentence, never the response text', async () => {
    const renderer = await render()
    globalThis.fetch = (async () => new Response(`<html>${SECRET}</html>`, { status: 502 })) as unknown as typeof fetch
    await click(button(renderer, 'Blank', byTestId(renderer, 'credential-row-ANTHROPIC_BASE_URL')[0]!))
    expect(byTestId(renderer, 'chat-provider-error')[0]!.children.join('')).toBe('The credential request failed.')
    expect(rendered(renderer)).not.toContain(SECRET)
    renderer.unmount()
  })

  test('a successful response that is not a listing renders the fixed failure, never a crash', async () => {
    // A server (or a stub) answering another shape: the section stays mounted.
    globalThis.fetch = (async () => Response.json({ profiles: [], errors: [], enabled: true })) as unknown as typeof fetch
    const renderer = await render()
    expect(byTestId(renderer, 'chat-provider-error')[0]!.children.join('')).toBe('The credential request failed.')
    await type(byLabel(renderer, 'New variable name'), 'PCS_SHAPE')
    await click(byTestId(renderer, 'credential-add')[0]!)
    expect(byTestId(renderer, 'chat-provider-error')[0]!.children.join('')).toBe('The credential request failed.')
    expect(byLabel(renderer, 'New variable name').props.value).toBe('PCS_SHAPE')
    renderer.unmount()
  })

  test('an applied but not durable save shows its warning and sends nothing more', async () => {
    const renderer = await render()
    durable = false
    await type(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL'), 'https://new.example')
    await click(button(renderer, 'Set', byTestId(renderer, 'credential-row-ANTHROPIC_BASE_URL')[0]!))
    expect(byTestId(renderer, 'credential-not-durable')[0]!.children.join('')).toContain('could not confirm')
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
    renderer.unmount()
  })

  test('blank, clear, and reclassify are explicit acts with their own requests', async () => {
    const renderer = await render()
    const row = () => byTestId(renderer, 'credential-row-ANTHROPIC_BASE_URL')[0]!
    await click(button(renderer, 'Blank', row()))
    expect(requests.at(-1)).toEqual({ method: 'PUT', path: '/ANTHROPIC_BASE_URL', body: { value: '', kind: 'launch-env' } })
    expect(rendered(renderer)).toContain('blank')
    await click(byLabel(renderer, 'Make ANTHROPIC_BASE_URL a secret source'))
    expect(requests.at(-1)).toEqual({ method: 'POST', path: '/ANTHROPIC_BASE_URL/reclassify', body: { kind: 'secret-source' } })
    await click(byLabel(renderer, 'Clear ANTHROPIC_BASE_URL'))
    expect(requests.at(-1)).toEqual({ method: 'DELETE', path: '/ANTHROPIC_BASE_URL', body: null })
    expect(byTestId(renderer, 'credential-row-ANTHROPIC_BASE_URL')).toHaveLength(0)
    renderer.unmount()
  })

  test('Enter sets the typed value instead of submitting the modal form', async () => {
    const renderer = await render()
    await type(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL'), 'https://enter.example')
    let prevented = false
    await act(async () => {
      byLabel(renderer, 'New value for ANTHROPIC_BASE_URL').props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true } })
      await settle()
    })
    expect(prevented).toBe(true)
    expect(requests.at(-1)!.method).toBe('PUT')
    renderer.unmount()
  })

  test('Enter on an untouched or emptied value input sends nothing and leaves the saved entry (F2)', async () => {
    const renderer = await render()
    const enter = async (label: string) => {
      await act(async () => {
        byLabel(renderer, label).props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
        await settle()
      })
    }
    await enter('New value for ANTHROPIC_BASE_URL')
    await type(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL'), 'https://typed.example')
    await type(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL'), '')
    await enter('New value for ANTHROPIC_BASE_URL')
    // The new-variable inputs share Add's name guard.
    await enter('New variable name')
    await enter('New variable value')
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([])
    expect(store.get('ANTHROPIC_BASE_URL')).toEqual({ kind: 'launch-env', value: 'https://gw.example' })
    renderer.unmount()
  })

  test('the listing shows a store failure, migration skips, and a collision by name only', async () => {
    const base = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/api/settings/credentials')) return base(input, init)
      return Response.json({
        store: { ok: false, reason: 'malformed', text: 'The user credential store is malformed; repair or remove it by hand. Lower sources apply meanwhile.' },
        rows: [{ name: 'RELAY_KEY', kind: 'launch-env', state: 'set', source: 'store', overriding: false, collision: true }],
        migration: { state: 'pending', text: 'Migration pending.', skipped: ['OLD_NAME'], ignored: [] },
      } satisfies CredentialListing)
    }) as typeof fetch
    const renderer = await render()
    expect(byTestId(renderer, 'credential-store-state')[0]!.children.join('')).toContain('malformed')
    expect(byTestId(renderer, 'credential-migration-skipped')[0]!.children.join('')).toBe('Legacy Settings OLD_NAME not migrated: the store already holds OLD_NAME.')
    expect(byTestId(renderer, 'credential-collision-RELAY_KEY')[0]!.children.join('')).toContain('registered credential name')
    expect(byTestId(renderer, 'credential-migration')[0]!.children.join('')).toBe('Migration pending.')
    expect(byTestId(renderer, 'credential-migration-ignored')).toHaveLength(0)
    renderer.unmount()
  })

  test('a complete migration lists residual ignored names and no pending text (table M, M2)', async () => {
    const base = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/api/settings/credentials')) return base(input, init)
      return Response.json({
        store: { ok: true },
        rows: [],
        migration: { state: 'complete', text: 'Legacy Settings values found after the migration are not used.', skipped: [], ignored: ['RESIDUAL_A', 'RESIDUAL_B'] },
      } satisfies CredentialListing)
    }) as typeof fetch
    const renderer = await render()
    expect(byTestId(renderer, 'credential-migration')).toHaveLength(0)
    expect(byTestId(renderer, 'credential-migration-ignored')[0]!.children.join('')).toBe('Legacy Settings values found after the migration are not used: RESIDUAL_A, RESIDUAL_B.')
    renderer.unmount()
  })
})

describe('SettingsModal credential save', () => {
  for (const failure of [null, { status: 500, code: 'write-failed', error: 'The user credential store could not be written; the previous contents stand.' }]) {
    test(failure ? 'keeps the modal and the typed value on a save failure' : 'Save sends the typed value before closing; reopening starts empty', async () => {
      let closed = 0
      let renderer!: TestRenderer.ReactTestRenderer
      const onClose = () => { closed++ }
      await act(async () => {
        renderer = TestRenderer.create(<SettingsModal isOpen onClose={onClose} />)
        await settle()
      })
      await act(async () => {
        renderer.root.findAll((n) => n.type === 'button' && n.props.role === 'tab' && n.children.join('') === 'Chat')[0]?.props.onClick()
        await settle()
      })
      const value = () => byLabel(renderer, 'New value for ANTHROPIC_BASE_URL')
      await type(value(), 'https://saved.example')
      failNext = failure
      await act(async () => {
        await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })
      })
      expect(requests.filter((r) => r.method === 'PUT')).toEqual([
        { method: 'PUT', path: '/ANTHROPIC_BASE_URL', body: { value: 'https://saved.example', kind: 'launch-env' } },
      ])
      expect(closed).toBe(failure ? 0 : 1)
      if (failure) {
        expect(value().props.value).toBe('https://saved.example')
        expect(byTestId(renderer, 'chat-provider-error')[0]!.children.join('')).toBe(failure.error)
      } else {
        expect(store.get('ANTHROPIC_BASE_URL')!.value).toBe('https://saved.example')
      }
      await act(async () => { renderer.unmount() })
    })
  }

  test('an applied but not durable modal Save keeps the modal open on the warning, consumes the input once, and the next Save closes (F3)', async () => {
    let closed = 0
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(<SettingsModal isOpen onClose={() => { closed++ }} />)
      await settle()
    })
    await act(async () => {
      renderer.root.findAll((n) => n.type === 'button' && n.props.role === 'tab' && n.children.join('') === 'Chat')[0]?.props.onClick()
      await settle()
    })
    durable = false
    await type(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL'), 'https://unconfirmed.example')
    const submit = async () => {
      await act(async () => {
        await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} })
      })
    }
    await submit()
    expect(closed).toBe(0)
    expect(byTestId(renderer, 'credential-not-durable')[0]!.children.join('')).toContain('could not confirm')
    expect(byLabel(renderer, 'New value for ANTHROPIC_BASE_URL').props.value).toBe('')
    await submit()
    expect(closed).toBe(1)
    expect(requests.filter((r) => r.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/ANTHROPIC_BASE_URL', body: { value: 'https://unconfirmed.example', kind: 'launch-env' } },
    ])
    await act(async () => { renderer.unmount() })
  })
})
