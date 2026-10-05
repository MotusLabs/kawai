import { expect, test } from 'bun:test'
import { createClaudeProfileRoutes, profileRequestError } from '../routes/claudeProfiles'

test('catalog returns identifiers and labels only', async () => {
  const response = await createClaudeProfileRoutes().request('/')
  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data).toHaveLength(6)
  for (const item of data) expect(Object.keys(item).sort()).toEqual(['id', 'label'])
})
test('creation validates profile IDs and refuses arbitrary launch options', () => {
  expect(profileRequestError({ kind: 'chat' })).toBeNull()
  expect(profileRequestError({ kind: 'chat', claudeProfileId: 'glm' })).toBeNull()
  expect(profileRequestError({ kind: 'chat', claudeProfileId: 'unknown' })).toContain('Unknown')
  expect(profileRequestError({ claudeProfileId: 'glm' })).toContain('only to chat')
  expect(profileRequestError({ kind: 'terminal' })).toBeNull()
  for (const key of ['env', 'providerEnv', 'settings', 'model', 'command']) {
    expect(profileRequestError({ kind: 'chat', [key]: 'custom' })).toContain('not accepted')
  }
})
