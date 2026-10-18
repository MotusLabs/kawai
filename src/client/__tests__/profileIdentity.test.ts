import { describe, expect, test } from 'bun:test'
import type { ClaudeProfileMetadata } from '@shared/chat'
import { profileIdentityLabels } from '../utils/profileIdentity'

const catalog: ClaudeProfileMetadata[] = [
  { id: 'default', label: 'Default', providerId: 'claude', providerLabel: 'Claude', runtime: 'claude' },
  { id: 'glm', label: 'GLM', providerId: 'zai', providerLabel: 'Z.AI', runtime: 'claude' },
  { id: 'mimo', label: 'MiMo', providerId: 'mimo', providerLabel: 'MiMo', runtime: 'claude' },
]

describe('profileIdentityLabels (chat header D13, review L4)', () => {
  test('a catalog entry yields its profile and provider labels', () => {
    expect(profileIdentityLabels(catalog, 'glm')).toEqual({ profileLabel: 'GLM', providerLabel: 'Z.AI' })
    expect(profileIdentityLabels(catalog, 'mimo')).toEqual({ profileLabel: 'MiMo', providerLabel: 'MiMo' })
  })

  test('a Codex profile names its provider Codex (task 3.4)', () => {
    const withCodex: ClaudeProfileMetadata[] = [
      ...catalog,
      { id: 'codex', label: 'Codex', providerId: 'codex-home-0123456789ab', providerLabel: 'Codex', runtime: 'codex' },
    ]
    expect(profileIdentityLabels(withCodex, 'codex')).toEqual({ profileLabel: 'Codex', providerLabel: 'Codex' })
  })

  test('the omitted selection resolves to default', () => {
    expect(profileIdentityLabels(catalog, 'default')).toEqual({ profileLabel: 'Default', providerLabel: 'Claude' })
  })

  test('a profile the catalog no longer defines falls back to the stored id', () => {
    expect(profileIdentityLabels(catalog, 'gone')).toEqual({ profileLabel: 'gone', providerLabel: 'gone' })
    expect(profileIdentityLabels([], 'default')).toEqual({ profileLabel: 'default', providerLabel: 'default' })
  })
})
