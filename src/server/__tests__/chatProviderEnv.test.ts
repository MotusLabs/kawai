import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  buildChatOptionsEnv,
  CHAT_PROVIDER_ENV_MAX_ENTRIES,
  CHAT_PROVIDER_ENV_MAX_VALUE_LENGTH,
  effectiveChatEnv,
  parseChatProviderEnv,
  validateChatProviderEnv,
} from '../chat/chatProviderEnv'

describe('parseChatProviderEnv', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => warn.mockClear())

  test('unset or blank yields no overrides', () => {
    expect(parseChatProviderEnv(undefined)).toEqual({})
    expect(parseChatProviderEnv('')).toEqual({})
    expect(parseChatProviderEnv(' ; ;')).toEqual({})
  })

  test('parses semicolon-separated pairs, trimming whitespace', () => {
    expect(
      parseChatProviderEnv(' ANTHROPIC_BASE_URL = https://gw.example/anthropic ;ANTHROPIC_MODEL=m-pro; ')
    ).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example/anthropic',
      ANTHROPIC_MODEL: 'm-pro',
    })
  })

  test('only the first "=" splits, so values may contain "="', () => {
    expect(parseChatProviderEnv('TOKEN=a=b==')).toEqual({ TOKEN: 'a=b==' })
  })

  test('an empty value is kept (it can blank an inherited variable)', () => {
    expect(parseChatProviderEnv('ANTHROPIC_API_KEY=')).toEqual({ ANTHROPIC_API_KEY: '' })
  })

  test('malformed pairs are skipped with a warning, the rest survive', () => {
    expect(parseChatProviderEnv('NOEQUALS;1BAD=x;has-dash=y;GOOD=1')).toEqual({ GOOD: '1' })
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe('validateChatProviderEnv', () => {
  test('accepts a map of valid names to strings', () => {
    expect(validateChatProviderEnv({ A: '1', _B2: '' })).toEqual({
      ok: true,
      env: { A: '1', _B2: '' },
    })
  })

  test.each([null, 'A=1', ['A'], 42])('refuses a non-object (%p)', (value) => {
    expect(validateChatProviderEnv(value).ok).toBe(false)
  })

  test('refuses an invalid name and names it', () => {
    const result = validateChatProviderEnv({ 'BAD NAME': 'x' })
    expect(result).toEqual({ ok: false, error: '"BAD NAME" is not a valid environment variable name.' })
  })

  test('refuses non-string, oversized, and NUL-containing values', () => {
    expect(validateChatProviderEnv({ A: 1 }).ok).toBe(false)
    expect(validateChatProviderEnv({ A: 'x'.repeat(CHAT_PROVIDER_ENV_MAX_VALUE_LENGTH + 1) }).ok).toBe(false)
    expect(validateChatProviderEnv({ A: 'a\0b' }).ok).toBe(false)
  })

  test('refuses too many entries', () => {
    const many = Object.fromEntries(
      Array.from({ length: CHAT_PROVIDER_ENV_MAX_ENTRIES + 1 }, (_, i) => [`V${i}`, 'x'])
    )
    expect(validateChatProviderEnv(many).ok).toBe(false)
  })
})

describe('buildChatOptionsEnv', () => {
  test('omits env entirely when there are no overrides', () => {
    expect(buildChatOptionsEnv({})).toBeUndefined()
  })

  test('spreads process.env and lets overrides win', () => {
    const env = buildChatOptionsEnv({ PATH: '/override', ANTHROPIC_MODEL: 'm' })!
    expect(env.PATH).toBe('/override')
    expect(env.ANTHROPIC_MODEL).toBe('m')
    expect(env.HOME).toBe(process.env.HOME)
  })

  test('effectiveChatEnv does not mutate process.env', () => {
    effectiveChatEnv({ AGENTBOARD_TEST_ONLY_VAR: '1' })
    expect(process.env.AGENTBOARD_TEST_ONLY_VAR).toBeUndefined()
  })
})
