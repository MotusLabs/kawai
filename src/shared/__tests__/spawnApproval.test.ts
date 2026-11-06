// unify-approval-defaults design D3 table, every group key × team default
// pair: the resolver's contract. A group key can only tighten.
import { describe, expect, test } from 'bun:test'
import type { ChatApprovalPolicy } from '../chat'
import { resolveSpawnApproval, spawnApprovalSourceLabel, type SpawnApprovalSource } from '../spawnApproval'

type Row = [group: ChatApprovalPolicy | undefined, team: ChatApprovalPolicy | null, policy: ChatApprovalPolicy, source: SpawnApprovalSource, ignoredGroupAuto: boolean]

// | group key | team default | policy | source   | ignoredGroupAuto |
const TABLE: Row[] = [
  [undefined, null, 'manual', 'built-in', false],
  [undefined, 'manual', 'manual', 'team', false],
  [undefined, 'auto', 'auto', 'team', false],
  ['manual', null, 'manual', 'group', false],
  ['manual', 'manual', 'manual', 'group', false],
  ['manual', 'auto', 'manual', 'group', false],
  ['auto', null, 'manual', 'built-in', true],
  ['auto', 'manual', 'manual', 'team', true],
  ['auto', 'auto', 'auto', 'team', true],
]

const GROUP_KEYS: Array<ChatApprovalPolicy | undefined> = [undefined, 'manual', 'auto']
const TEAM_DEFAULTS: Array<ChatApprovalPolicy | null> = [null, 'manual', 'auto']

describe('resolveSpawnApproval', () => {
  for (const [group, team, policy, source, ignoredGroupAuto] of TABLE) {
    test(`group ${group ?? 'absent'} × team ${team ?? 'none'} → ${policy} (${source})`, () => {
      expect(resolveSpawnApproval(group, team)).toEqual({ policy, source, ignoredGroupAuto })
    })
  }

  test('the table covers every group key × team default pair exactly once', () => {
    const keys = TABLE.map(([group, team]) => `${group}|${team}`)
    expect(new Set(keys).size).toBe(GROUP_KEYS.length * TEAM_DEFAULTS.length)
    expect(keys.length).toBe(GROUP_KEYS.length * TEAM_DEFAULTS.length)
  })

  test('property: the policy is auto only when the team default is auto', () => {
    for (const group of GROUP_KEYS) {
      for (const team of TEAM_DEFAULTS) {
        const { policy, source } = resolveSpawnApproval(group, team)
        if (policy === 'auto') expect(team).toBe('auto')
        // A group key is the source only when it tightened.
        if (source === 'group') expect(group).toBe('manual')
      }
    }
  })

  test('labels each source for the UI', () => {
    expect(spawnApprovalSourceLabel('group')).toBe('group file')
    expect(spawnApprovalSourceLabel('team')).toBe('team default')
    expect(spawnApprovalSourceLabel('built-in')).toBe('built-in')
  })
})
