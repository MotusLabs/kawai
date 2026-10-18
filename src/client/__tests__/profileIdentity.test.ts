import { describe, expect, test } from 'bun:test'
import { profileIdentityLabels } from '../utils/profileIdentity'

const catalog = [
  { id: 'default', label: 'Default', providerId: 'claude', providerLabel: 'Claude' },
  { id: 'glm', label: 'GLM', providerId: 'zai', providerLabel: 'Z.AI' },
  { id: 'mimo', label: 'MiMo', providerId: 'mimo', providerLabel: 'MiMo' },
]

describe('profileIdentityLabels (chat header D13, review L4)', () => {
  test('a catalog entry yields its profile and provider labels', () => {
    expect(profileIdentityLabels(catalog, 'glm')).toEqual({ profileLabel: 'GLM', providerLabel: 'Z.AI' })
    expect(profileIdentityLabels(catalog, 'mimo')).toEqual({ profileLabel: 'MiMo', providerLabel: 'MiMo' })
  })

  test('the omitted selection resolves to default', () => {
    expect(profileIdentityLabels(catalog, 'default')).toEqual({ profileLabel: 'Default', providerLabel: 'Claude' })
  })

  test('a profile the catalog no longer defines falls back to the stored id', () => {
    expect(profileIdentityLabels(catalog, 'gone')).toEqual({ profileLabel: 'gone', providerLabel: 'gone' })
    expect(profileIdentityLabels([], 'default')).toEqual({ profileLabel: 'default', providerLabel: 'default' })
  })
})
