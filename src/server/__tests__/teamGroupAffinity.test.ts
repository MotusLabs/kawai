// Group frontmatter `affinity` and `affinityWait` (group-mail-task-affinity
// D2, task 1.1): `task-owner` is the only kind, the wait is whole minutes
// (default 30), and every bad value is a warning that leaves affinity off or
// the default wait in place — never a rejected file.
import { describe, expect, test } from 'bun:test'
import { DEFAULT_AFFINITY_WAIT_MS, parseGroupFile } from '../team/groupFile'

const parse = (frontmatter: string) => {
  const parsed = parseGroupFile('lead', `---\nlabel: Lead\n${frontmatter}\n---\nLead.`)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.group
}

describe('group affinity frontmatter', () => {
  test('a valid pair reads the kind and the wait in milliseconds', () => {
    const group = parse('affinity: task-owner\naffinityWait: 45')
    expect(group.affinity).toEqual({ kind: 'task-owner', waitMs: 45 * 60_000 })
    expect(group.warnings).toEqual([])
  })

  test('an absent wait defaults to 30 minutes', () => {
    const group = parse('affinity: task-owner')
    expect(DEFAULT_AFFINITY_WAIT_MS).toBe(30 * 60_000)
    expect(group.affinity).toEqual({ kind: 'task-owner', waitMs: 30 * 60_000 })
  })

  test('affinityWait 0 prefers an idle owner without ever waiting', () => {
    expect(parse('affinity: task-owner\naffinityWait: 0').affinity).toEqual({ kind: 'task-owner', waitMs: 0 })
  })

  // @covers: team-routing-rules › Groups may route by task owner › Invalid affinity value
  test('affinity: newest warns and leaves affinity off; the rest of the file applies', () => {
    const group = parse('affinity: newest\nmax: 2')
    expect(group.affinity).toBeUndefined()
    expect(group.max).toBe(2)
    expect(group.warnings).toEqual(['affinity must be task-owner, got "newest"; ignored'])
  })

  // @covers: team-routing-rules › Groups may route by task owner › Invalid wait value
  test('invalid waits warn and keep the 30-minute default', () => {
    for (const raw of ['-1', '2.5', '30m', 'soon']) {
      const group = parse(`affinity: task-owner\naffinityWait: ${raw}`)
      expect(group.affinity).toEqual({ kind: 'task-owner', waitMs: 30 * 60_000 })
      expect(group.warnings).toEqual([`affinityWait must be whole minutes, got "${raw}"; using 30`])
    }
  })

  test('absent keys leave affinity unset with no warning', () => {
    const group = parse('max: 1')
    expect('affinity' in group).toBe(false)
    expect(group.warnings).toEqual([])
  })

  test('a wait without affinity warns and enables nothing', () => {
    const group = parse('affinityWait: 10')
    expect(group.affinity).toBeUndefined()
    expect(group.warnings).toEqual(['affinityWait is ignored; affinity is not set'])
  })
})
