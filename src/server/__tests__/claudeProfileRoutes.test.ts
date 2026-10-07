import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClaudeProfileRoutes, profileRequestError } from '../routes/claudeProfiles'

// Catalog reads resolve against an empty temp home: the shipped default
// applies deterministically, and a real ~/.kawai cannot leak in.
let tempHome: string
const originalHome = process.env.HOME
beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profileroutes-'))
  process.env.HOME = tempHome
})
afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  fs.rmSync(tempHome, { recursive: true, force: true })
})

test('catalog returns identifiers and labels only', async () => {
  const response = await createClaudeProfileRoutes().request('/')
  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data).toHaveLength(6)
  for (const item of data) expect(Object.keys(item).sort()).toEqual(['id', 'label'])
})

test('catalog resolves per requested project path', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profilepath-'))
  try {
    // Unknown before the file exists; known after .kawai defines it.
    const before = await createClaudeProfileRoutes().request(`/?projectPath=${encodeURIComponent(project)}`)
    const beforeData = await before.json()
    expect(beforeData.some((profile: { id: string }) => profile.id === 'glm-flash')).toBe(false)

    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'glm-flash': { label: 'GLM Flash', model: 'glm-5.3-flash[1m]' },
    }))
    const after = await createClaudeProfileRoutes().request(`/?projectPath=${encodeURIComponent(project)}`)
    const afterData = await after.json()
    const entry = afterData.find((profile: { id: string }) => profile.id === 'glm-flash')
    expect(entry).toEqual({ id: 'glm-flash', label: 'GLM Flash' })
    // Credentials and environment maps never cross the boundary.
    for (const item of afterData) expect(Object.keys(item).sort()).toEqual(['id', 'label'])

    // Session-create validation uses the same per-path catalog.
    expect(profileRequestError({ kind: 'chat', projectPath: project, claudeProfileId: 'glm-flash' })).toBeNull()
    expect(profileRequestError({ kind: 'chat', projectPath: project, claudeProfileId: 'unknown' })).toContain('Unknown')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('creation validates profile IDs and refuses arbitrary launch options', () => {
  expect(profileRequestError({ kind: 'chat' })).toBeNull()
  expect(profileRequestError({ kind: 'chat', claudeProfileId: 'glm' })).toBeNull()
  expect(profileRequestError({ kind: 'chat', claudeProfileId: 'unknown' })).toContain('Unknown')
  expect(profileRequestError({ claudeProfileId: 'glm' })).toContain('only to chat')
  expect(profileRequestError({ kind: 'terminal' })).toBeNull()
  for (const key of ['env', 'providerEnv', 'settings', 'model', 'command', 'executable', 'claudeExecutablePath', 'pathToClaudeCodeExecutable']) {
    expect(profileRequestError({ kind: 'chat', [key]: 'custom' })).toContain('not accepted')
  }
})
