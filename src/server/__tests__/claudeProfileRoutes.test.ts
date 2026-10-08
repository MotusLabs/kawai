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
  expect(data.errors).toEqual([])
  expect(data.profiles).toHaveLength(6)
  for (const item of data.profiles) expect(Object.keys(item).sort()).toEqual(['id', 'label'])
})

test('catalog resolves per requested project path', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profilepath-'))
  try {
    // Unknown before the file exists; known after .kawai defines it.
    const before = await createClaudeProfileRoutes().request(`/?projectPath=${encodeURIComponent(project)}`)
    const beforeData = await before.json()
    expect(beforeData.profiles.some((profile: { id: string }) => profile.id === 'glm-flash')).toBe(false)

    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
      'glm-flash': { label: 'GLM Flash', model: 'glm-5.3-flash[1m]' },
    }))
    const after = await createClaudeProfileRoutes().request(`/?projectPath=${encodeURIComponent(project)}`)
    const afterData = await after.json()
    const entry = afterData.profiles.find((profile: { id: string }) => profile.id === 'glm-flash')
    expect(entry).toEqual({ id: 'glm-flash', label: 'GLM Flash' })
    // Credentials and environment maps never cross the boundary.
    for (const item of afterData.profiles) expect(Object.keys(item).sort()).toEqual(['id', 'label'])

    // Session-create validation uses the same per-path catalog.
    expect(profileRequestError({ kind: 'chat', projectPath: project, claudeProfileId: 'glm-flash' })).toBeNull()
    expect(profileRequestError({ kind: 'chat', projectPath: project, claudeProfileId: 'unknown' })).toContain('Unknown')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('home-relative project paths resolve the same catalog as creation', async () => {
  const project = path.join(tempHome, 'proj')
  fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai', 'profiles.json'), JSON.stringify({
    'home-proj': { label: 'Home Proj' },
  }))
  try {
    // Typed as `~/proj`, the picker sees the project's entry...
    const response = await createClaudeProfileRoutes().request(`/?projectPath=${encodeURIComponent('~/proj')}`)
    const data = await response.json()
    expect(data.errors).toEqual([])
    expect(data.profiles.some((profile: { id: string }) => profile.id === 'home-proj')).toBe(true)
    // ...and creation validation accepts it instead of rejecting the id.
    expect(profileRequestError({ kind: 'chat', projectPath: '~/proj', claudeProfileId: 'home-proj' })).toBeNull()
    expect(profileRequestError({ kind: 'chat', projectPath: '~/proj', claudeProfileId: 'glm' })).toBeNull()
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('catalog file failures are reported while the rest resolves', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-profilebad-'))
  try {
    const badFile = path.join(project, '.kawai', 'profiles.json')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(badFile, '{ not json')
    const response = await createClaudeProfileRoutes().request(`/?projectPath=${encodeURIComponent(project)}`)
    const data = await response.json()
    expect(data.errors).toHaveLength(1)
    expect(data.errors[0]).toContain(badFile)
    // The shipped catalog still resolves, so creation remains possible.
    expect(data.profiles.some((profile: { id: string }) => profile.id === 'default')).toBe(true)
    expect(data.profiles.some((profile: { id: string }) => profile.id === 'glm')).toBe(true)
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
