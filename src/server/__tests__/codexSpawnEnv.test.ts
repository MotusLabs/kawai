// Task 3.2: the Codex spawn env is exactly CODEX_HOME, and no Codex home or
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

describe('the Codex spawn environment (task 3.2)', () => {
  test('the spawn env is exactly CODEX_HOME at the resolved home', () => {
    expect(codexSpawnEnv('/srv/codex')).toEqual({ CODEX_HOME: '/srv/codex' })
    expect(Object.keys(codexSpawnEnv('/srv/codex'))).toEqual(['CODEX_HOME'])
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
      // The home path appears nowhere, whatever the payload later gains
      // (task 3.4 adds Codex rows; this scan must stay green).
      expect(payload).not.toContain(secretHome)
      expect(payload).not.toContain('CODEX_HOME')
      // Claude entries keep the controlled env on the server, too.
      expect(payload).not.toContain('ANTHROPIC_BASE_URL')
    }
    // Task 3.2 keeps Codex profiles out of the picker view entirely; task
    // 3.4 adds them with their runtime and keeps the scans above green.
    expect(claudeProfileCatalog(ctx).profiles.some(profile => profile.id === 'codex')).toBe(false)
  })
})
