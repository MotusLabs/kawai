// Task 3.2: the Codex spawn env is the server environment minus the
// provider variables, plus CODEX_HOME (design D4), and no Codex home or
// environment value ever reaches the profiles route payload — the boundary
// the claude-session-profiles delta states as "The Codex home SHALL NOT be
// sent to browsers".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexSpawnEnv } from '../chat/codexProfiles'
import { claudeProfileCatalog, claudeProfileMetadata } from '../chat/ClaudeProfiles'

let tempRoot: string
let homeDir: string

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-codex-spawn-'))
  homeDir = path.join(tempRoot, 'home')
  fs.mkdirSync(homeDir, { recursive: true })
})

afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

function writeProfiles(json: unknown): void {
  fs.mkdirSync(path.join(homeDir, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(homeDir, '.kawai', 'profiles.json'), JSON.stringify(json))
}

describe('the Codex spawn environment (task 3.2, design D4)', () => {
  test('the spawn env carries the server env minus provider variables, plus CODEX_HOME', () => {
    const env = codexSpawnEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/smoke',
      LANG: 'C.UTF-8',
      CODEX_HOME: '/elsewhere',
      AGENTBOARD_CHAT_ENV: 'ANTHROPIC_BASE_URL=https://gw.example.internal',
      ANTHROPIC_API_KEY: 'not-a-real-key',
      ANTHROPIC_BASE_URL: 'https://gw.example.internal',
      CLAUDE_CODE_ATTRIBUTION_HEADER: 'x',
      CLAUDE_CONFIG_DIR: '/home/smoke/.claude',
    }, '/srv/codex', new Set())
    // PATH and HOME survive: a `#!/usr/bin/env node` codex must start (B2).
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/home/smoke')
    expect(env.LANG).toBe('C.UTF-8')
    // The provider variables never reach the child: every ANTHROPIC_* and
    // CLAUDE_CODE_* name, CLAUDE_CONFIG_DIR (R2-4), and the
    // AGENTBOARD_CHAT_ENV overrides.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.AGENTBOARD_CHAT_ENV).toBeUndefined()
    expect(Object.keys(env).some(name => name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_')))
      .toBe(false)
    // CODEX_HOME is the resolved home, not the server's own value.
    expect(env.CODEX_HOME).toBe('/srv/codex')
  })

  test('the catalog-named credential variables never reach the child (openrouter-provider 1.8)', () => {
    const env = codexSpawnEnv(
      { PATH: '/usr/bin', OPENROUTER_API_KEY: 'fake-or-key', OPENROUTER_MANAGEMENT_KEY: 'fake-or-mgmt', OTHER: 'kept' },
      '/srv/codex',
      new Set(['OPENROUTER_API_KEY', 'OPENROUTER_MANAGEMENT_KEY']),
    )
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'OTHER', 'PATH'])
  })

  test('no Codex home or env value reaches the profiles route payload', () => {
    const secretHome = path.join(tempRoot, 'secret-codex-home')
    writeProfiles({
      codex: {
        label: 'Codex',
        runtime: 'codex',
        model: 'gpt-5.3-codex',
        codexHome: secretHome,
      },
      acme: { label: 'Acme', env: { ANTHROPIC_BASE_URL: 'https://acme.example.internal' } },
    })
    const ctx = { homeDir, serverCodexHome: secretHome }
    for (const view of [claudeProfileCatalog(ctx), { profiles: claudeProfileMetadata(ctx) }]) {
      const payload = JSON.stringify(view)
      // The home path appears nowhere, whatever the payload later gains.
      expect(payload).not.toContain(secretHome)
      expect(payload).not.toContain('CODEX_HOME')
      // Claude entries keep the controlled env on the server, too.
      expect(payload).not.toContain('ANTHROPIC_BASE_URL')
    }
    // Task 3.4: the Codex profile rides the picker view with its runtime,
    // the scans above still green — the model name crosses no more than the
    // home does.
    const codex = claudeProfileCatalog(ctx).profiles.find(profile => profile.id === 'codex')
    expect(codex?.label).toBe('Codex')
    expect(codex?.providerId).toMatch(/^codex-home-[0-9a-f]{12}$/)
    expect(codex?.providerLabel).toBe('Codex')
    expect(codex?.runtime).toBe('codex')
    expect(JSON.stringify(claudeProfileCatalog(ctx).profiles)).not.toContain('gpt-5.3-codex')
  })
})
