import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatProviderEnvResponse } from '@shared/chatProviderSettings'
import ChatProviderSettings, { rowsToUpdate } from '../components/ChatProviderSettings'

interface Recorded {
  method: string
  body: unknown
}

const originalFetch = globalThis.fetch
let requests: Recorded[]
/** Per-method responder; defaults echo a server holding `serverState`. */
let serverState: ChatProviderEnvResponse
let failNext: { status: number; error: string } | null

beforeEach(() => {
  requests = []
  failNext = null
  serverState = {
    env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: '' },
    redacted: ['ANTHROPIC_AUTH_TOKEN'],
    source: 'settings',
  }
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ method, body })
    if (failNext) {
      const { status, error } = failNext
      failNext = null
      return new Response(JSON.stringify({ error }), { status })
    }
    if (method === 'PUT') {
      const env = (body as { env: Record<string, string> }).env
      serverState = { env, redacted: [], source: 'settings' }
    }
    if (method === 'DELETE') {
      serverState = { env: { ANTHROPIC_BASE_URL: 'https://default' }, redacted: [], source: 'environment' }
    }
    return new Response(JSON.stringify(serverState), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
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

const inputs = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAllByType('input')

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

describe('ChatProviderSettings', () => {
  test('loads the stored overrides and shows where they came from', async () => {
    const renderer = await render()
    const fields = inputs(renderer)
    expect(fields.map((f) => f.props.value)).toEqual([
      'ANTHROPIC_BASE_URL', 'https://gw.example', 'ANTHROPIC_AUTH_TOKEN', '',
    ])
    // The redacted credential is a password field with a keep hint.
    expect(fields[3]!.props.type).toBe('password')
    expect(fields[3]!.props.placeholder).toContain('leave blank to keep')
    expect(byTestId(renderer, 'chat-provider-source')[0]!.children.join('')).toContain('saved here')
    expect(byTestId(renderer, 'chat-provider-apply')[0]!.props.disabled).toBe(true)
    renderer.unmount()
  })

  test('apply PUTs the edited map and keeps an untouched credential', async () => {
    const renderer = await render()
    await type(inputs(renderer)[1]!, 'https://other.example')
    const apply = byTestId(renderer, 'chat-provider-apply')[0]!
    expect(apply.props.disabled).toBe(false)
    await click(apply)
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      body: {
        env: { ANTHROPIC_BASE_URL: 'https://other.example', ANTHROPIC_AUTH_TOKEN: '' },
        keep: ['ANTHROPIC_AUTH_TOKEN'],
      },
    })
    expect(byTestId(renderer, 'chat-provider-error')).toHaveLength(0)
    renderer.unmount()
  })

  test('adding and removing rows changes what is saved', async () => {
    const renderer = await render()
    await click(renderer.root.findAll((n) => n.type === 'button' && n.children.includes('+ Add Variable'))[0]!)
    const fields = inputs(renderer)
    await type(fields[4]!, 'ANTHROPIC_MODEL')
    await type(inputs(renderer)[5]!, 'gw-pro')
    await click(renderer.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === 'Remove ANTHROPIC_AUTH_TOKEN')[0]!)
    await click(byTestId(renderer, 'chat-provider-apply')[0]!)
    expect(requests.at(-1)!.body).toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_MODEL: 'gw-pro' },
    })
    renderer.unmount()
  })

  test('a server refusal is shown and the edits are kept', async () => {
    const renderer = await render()
    await type(inputs(renderer)[0]!, 'BAD NAME')
    failNext = { status: 400, error: '"BAD NAME" is not a valid environment variable name.' }
    await click(byTestId(renderer, 'chat-provider-apply')[0]!)
    const error = byTestId(renderer, 'chat-provider-error')[0]!
    expect(error.props.role).toBe('alert')
    expect(error.children.join('')).toContain('not a valid environment variable name')
    expect(inputs(renderer)[0]!.props.value).toBe('BAD NAME')
    renderer.unmount()
  })

  test('reset DELETEs the override and shows the environment default', async () => {
    const renderer = await render()
    await click(byTestId(renderer, 'chat-provider-reset')[0]!)
    expect(requests.at(-1)!.method).toBe('DELETE')
    expect(inputs(renderer).map((f) => f.props.value)).toEqual(['ANTHROPIC_BASE_URL', 'https://default'])
    expect(byTestId(renderer, 'chat-provider-source')[0]!.children.join('')).toContain('AGENTBOARD_CHAT_ENV')
    // Nothing to reset once the default is in effect.
    expect(byTestId(renderer, 'chat-provider-reset')).toHaveLength(0)
    renderer.unmount()
  })

  test('Enter applies the section instead of submitting the modal form', async () => {
    const renderer = await render()
    await type(inputs(renderer)[1]!, 'https://enter.example')
    let prevented = false
    await act(async () => {
      inputs(renderer)[1]!.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true } })
      await settle()
    })
    expect(prevented).toBe(true)
    expect(requests.at(-1)!.method).toBe('PUT')
    renderer.unmount()
  })

  test('a failed load is reported', async () => {
    failNext = { status: 500, error: 'boom' }
    const renderer = await render()
    expect(byTestId(renderer, 'chat-provider-error')[0]!.children.join('')).toContain('boom')
    renderer.unmount()
  })
})

describe('rowsToUpdate', () => {
  const row = (name: string, value: string, redacted = false) => ({ id: 0, name, value, redacted })

  test('skips blank rows and trims names', () => {
    expect(rowsToUpdate([row('  A ', '1'), row('', '')])).toEqual({ env: { A: '1' } })
  })

  test('refuses a value without a name and duplicate names', () => {
    expect(rowsToUpdate([row('', 'x')])).toBe('Every value needs a variable name.')
    expect(rowsToUpdate([row('A', '1'), row('A', '2')])).toBe('A appears more than once.')
  })

  test('a redacted row left blank is kept; one with a new value is replaced', () => {
    expect(rowsToUpdate([row('T_TOKEN', '', true), row('U_TOKEN', 'new', true)])).toEqual({
      env: { T_TOKEN: '', U_TOKEN: 'new' },
      keep: ['T_TOKEN'],
    })
  })
})
