// plan-execution design D8: the manifest hash is stable under key order.
import { describe, expect, test } from 'bun:test'
import type { AttemptManifest } from '../../shared/planExecution'
import { hashManifest } from '../plans/execution/manifestHash'

const manifest: AttemptManifest = {
  version: 1,
  plan: { id: 'p1', revision: 2, contentHash: 'h' },
  execution: 'e1',
  task: { id: 't1', revision: 1 },
  validation: { reportId: 'r1', inputHash: 'i' },
  baseline: 'b',
  startCommit: 's',
  artifacts: { 'proposal.md': 'a', 'design.md': 'd' },
  roleProfiles: ['opus', 'sonnet'],
}

describe('hashManifest', () => {
  test('the hash is stable under key order and changes with content', () => {
    const reordered = JSON.parse(JSON.stringify({
      roleProfiles: manifest.roleProfiles, startCommit: 's', baseline: 'b', validation: { inputHash: 'i', reportId: 'r1' },
      task: { revision: 1, id: 't1' }, execution: 'e1', artifacts: { 'design.md': 'd', 'proposal.md': 'a' },
      plan: { contentHash: 'h', revision: 2, id: 'p1' }, version: 1,
    })) as AttemptManifest
    expect(hashManifest(reordered)).toBe(hashManifest(manifest))
    expect(hashManifest(manifest)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashManifest({ ...manifest, roleProfiles: ['sonnet', 'opus'] })).not.toBe(hashManifest(manifest))
  })
})
