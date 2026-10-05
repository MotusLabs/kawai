import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatProviderEnvResponse } from '../../shared/chatProviderSettings'
import { initDatabase, type SessionDatabase } from '../db'
import {
  CHAT_PROVIDER_ENV_KEY,
  createChatProviderEnvStore,
  isSecretEnvName,
} from '../routes/chatProviderEnv'

const DEFAULT_ENV = { ANTHROPIC_BASE_URL: 'https://default.example' }

describe('chat provider env settings', () => {
  let tempDir: string
  let db: SessionDatabase

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-chatenv-'))
    db = initDatabase({ path: path.join(tempDir, 'test.db') })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  async function call(
    store: ReturnType<typeof createChatProviderEnvStore>,
    method: 'GET' | 'PUT' | 'DELETE',
    body?: unknown
  ): Promise<{ status: number; json: ChatProviderEnvResponse & { error?: string } }> {
    const response = await store.routes.request('/', {
      method,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    })
    return { status: response.status, json: await response.json() }
  }

  test('falls back to the environment default with no stored override', async () => {
    const store = createChatProviderEnvStore(db, DEFAULT_ENV)
    expect(store.current()).toEqual(DEFAULT_ENV)
    const { json } = await call(store, 'GET')
    expect(json).toEqual({ env: DEFAULT_ENV, redacted: [], source: 'environment' })
  })

  test('reports none when nothing is configured anywhere', async () => {
    const store = createChatProviderEnvStore(db, {})
    expect((await call(store, 'GET')).json.source).toBe('none')
  })

  test('PUT persists an override that applies immediately and survives a restart', async () => {
    const store = createChatProviderEnvStore(db, DEFAULT_ENV)
    const next = { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_MODEL: 'gw-pro' }
    const put = await call(store, 'PUT', { env: next })
    expect(put.status).toBe(200)
    expect(put.json).toEqual({ env: next, redacted: [], source: 'settings' })
    expect(store.current()).toEqual(next)
    expect(createChatProviderEnvStore(db, DEFAULT_ENV).current()).toEqual(next)
  })

  test('an empty override is kept distinct from "use the default"', async () => {
    const store = createChatProviderEnvStore(db, DEFAULT_ENV)
    await call(store, 'PUT', { env: {} })
    expect(store.current()).toEqual({})
    expect((await call(store, 'GET')).json.source).toBe('settings')
  })

  test('DELETE drops the override and restores the environment default', async () => {
    const store = createChatProviderEnvStore(db, DEFAULT_ENV)
    await call(store, 'PUT', { env: { ANTHROPIC_MODEL: 'x' } })
    const reset = await call(store, 'DELETE')
    expect(reset.status).toBe(200)
    expect(reset.json.source).toBe('environment')
    expect(store.current()).toEqual(DEFAULT_ENV)
    expect(db.getAppSetting(CHAT_PROVIDER_ENV_KEY)).toBeNull()
  })

  test('invalid input is refused and changes nothing', async () => {
    const store = createChatProviderEnvStore(db, DEFAULT_ENV)
    for (const body of ['not json', { env: { 'BAD NAME': 'x' } }, { env: 'A=1' }, { env: {}, keep: 'A' }]) {
      const result = await call(store, 'PUT', body)
      expect(result.status).toBe(400)
      expect(result.json.error).toBeTruthy()
    }
    expect(store.current()).toEqual(DEFAULT_ENV)
    expect(db.getAppSetting(CHAT_PROVIDER_ENV_KEY)).toBeNull()
  })

  test('credential-looking values are redacted and can be kept without resending', async () => {
    const store = createChatProviderEnvStore(db, {})
    await call(store, 'PUT', { env: { ANTHROPIC_AUTH_TOKEN: 's3cret', ANTHROPIC_MODEL: 'm' } })
    const got = (await call(store, 'GET')).json
    expect(got.env).toEqual({ ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: 'm' })
    expect(got.redacted).toEqual(['ANTHROPIC_AUTH_TOKEN'])
    expect(JSON.stringify(got)).not.toContain('s3cret')

    // Edit the model, keep the token the client never saw.
    const put = await call(store, 'PUT', {
      env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: 'm2' },
      keep: ['ANTHROPIC_AUTH_TOKEN'],
    })
    expect(put.status).toBe(200)
    expect(store.current()).toEqual({ ANTHROPIC_AUTH_TOKEN: 's3cret', ANTHROPIC_MODEL: 'm2' })
  })

  test('keep is refused for names that are not stored, not secret, or not submitted', async () => {
    const store = createChatProviderEnvStore(db, {})
    await call(store, 'PUT', { env: { ANTHROPIC_MODEL: 'm' } })
    for (const body of [
      { env: { ANTHROPIC_API_KEY: '' }, keep: ['ANTHROPIC_API_KEY'] },
      { env: { ANTHROPIC_MODEL: '' }, keep: ['ANTHROPIC_MODEL'] },
      { env: {}, keep: ['ANTHROPIC_MODEL'] },
    ]) {
      expect((await call(store, 'PUT', body)).status).toBe(400)
    }
    expect(store.current()).toEqual({ ANTHROPIC_MODEL: 'm' })
  })

  test('a corrupt stored row is ignored in favor of the default', () => {
    db.setAppSetting(CHAT_PROVIDER_ENV_KEY, '{not json')
    expect(createChatProviderEnvStore(db, DEFAULT_ENV).current()).toEqual(DEFAULT_ENV)
    db.setAppSetting(CHAT_PROVIDER_ENV_KEY, JSON.stringify({ 'BAD NAME': 'x' }))
    expect(createChatProviderEnvStore(db, DEFAULT_ENV).current()).toEqual(DEFAULT_ENV)
  })

  test('a persist failure leaves the live value unchanged', async () => {
    const failing = {
      getAppSetting: () => null,
      setAppSetting: () => { throw new Error('disk full') },
      deleteAppSetting: () => { throw new Error('disk full') },
    }
    const store = createChatProviderEnvStore(failing, DEFAULT_ENV)
    expect((await call(store, 'PUT', { env: { A: '1' } })).status).toBe(500)
    expect((await call(store, 'DELETE')).status).toBe(500)
    expect(store.current()).toEqual(DEFAULT_ENV)
  })

  test('isSecretEnvName', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MY_SECRET', 'DB_PASSWORD']) {
      expect(isSecretEnvName(name)).toBe(true)
    }
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
      expect(isSecretEnvName(name)).toBe(false)
    }
  })
})
