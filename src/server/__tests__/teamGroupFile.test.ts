import { describe, expect, test } from 'bun:test'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS, parseDuration, parseGroupFile, type GroupDefinition, type GroupEffort } from '../team/groupFile'

const ROUTING_DEFAULTS = {
  canCreatePlans: false,
  canManageMailbox: false,
  profiles: [],
  strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' },
  warnings: [],
} as const satisfies Partial<GroupDefinition>

describe('parseGroupFile', () => {
  test('reads label, description, hop limit, and the body as role prompt', () => {
    const parsed = parseGroupFile('architects', [
      '---',
      '# owners of the system shape',
      'label: Architects',
      'description: "Owns system design"',
      'hopLimit: 8',
      'futureSetting: ignored',
      '---',
      '',
      'You review designs.',
      '',
      'Keep answers short.',
      '',
    ].join('\n'))
    expect(parsed).toEqual({
      ok: true,
      group: {
        id: 'architects',
        label: 'Architects',
        description: 'Owns system design',
        hopLimit: 8,
        canCreateTasks: false,
        releaseOnTaskClose: true,
        worktreeScoped: true,
        canReleaseMembers: true,
        max: 1,
        approval: 'manual',
        ...ROUTING_DEFAULTS,
        prompt: 'You review designs.\n\nKeep answers short.',
      },
    })
  })

  test('a body-only file defaults the label to the id', () => {
    expect(parseGroupFile('qa', 'Test everything.\n')).toEqual({
      ok: true,
      group: { id: 'qa', label: 'qa', description: '', canCreateTasks: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, max: 1, approval: 'manual', ...ROUTING_DEFAULTS, prompt: 'Test everything.' },
    })
  })

  test('an empty label also falls back to the id; CRLF and BOM are tolerated', () => {
    const parsed = parseGroupFile('devs', "﻿---\r\nlabel: ''\r\n---\r\nBuild it.")
    expect(parsed.ok && parsed.group).toMatchObject({ label: 'devs', prompt: 'Build it.' })
  })

  test('malformed frontmatter is an error, not a group', () => {
    for (const [content, error] of [
      ['---\nlabel: A\nBuild', 'not closed'],
      ['---\njust words\n---\n', 'line 2'],
      ['---\nlabel: "open\n---\n', 'unterminated quote'],
      ['---\nlabel: A\nlabel: B\n---\n', 'repeated'],
      ['---\nhopLimit: 0\n---\n', 'positive integer'],
      ['---\nhopLimit: many\n---\n', 'positive integer'],
      ['---\ncanCreateTasks: yes\n---\n', 'canCreateTasks must be true or false'],
      ['---\nmax: 0\n---\n', 'max must be a positive integer'],
      ['---\nmax: 1.5\n---\n', 'max must be a positive integer'],
      ['---\nprofile: GLM Pro\n---\n', 'not a valid profile id'],
      ['---\napproval: always\n---\n', 'approval must be manual or auto'],
      ['---\nprofile: glm\nprofiles: [glm]\n---\n', 'either profile or profiles'],
      ['---\nprofiles: glm, mimo\n---\n', 'expected [ ... ] or { ... }'],
      ['---\nprofiles: [glm, mimo\n---\n', 'not closed'],
      ['---\nprofiles: [glm, [mimo]]\n---\n', 'nested'],
      ['---\nprofiles: { glm: { cap: 2 } }\n---\n', 'nested'],
      ['---\nprofiles: [glm, , mimo]\n---\n', 'empty item'],
      ['---\nprofiles: []\n---\n', 'at least one'],
      ['---\nprofiles: [glm, glm]\n---\n', 'listed twice'],
      ['---\nprofiles: [GLM]\n---\n', 'not a valid profile id'],
      ['---\nprofiles: { glm: 0 }\n---\n', 'positive integer'],
      ['---\nprofiles: { glm }\n---\n', 'not "key: value"'],
      ['---\nstrategy: random\n---\n', 'strategy must be'],
    ] as const) {
      const parsed = parseGroupFile('x', content)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(error)
    }
  })

  test('reads team-task settings: creation right, member cap, profile, approval', () => {
    const parsed = parseGroupFile('leads', [
      '---',
      'canCreateTasks: true',
      'max: 3',
      'profile: glm',
      "approval: 'auto'",
      '---',
      'Lead.',
    ].join('\n'))
    expect(parsed.ok && parsed.group).toMatchObject({ canCreateTasks: true, max: 3, profiles: [{ profileId: 'glm' }], approval: 'auto' })
  })

  test('task settings default to no creation right, one member, default profile, manual approval', () => {
    const parsed = parseGroupFile('devs', '---\ncanCreateTasks: false\n---\nBuild.')
    expect(parsed.ok && parsed.group).toEqual({
      id: 'devs', label: 'devs', description: '', canCreateTasks: false, releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, max: 1, approval: 'manual', ...ROUTING_DEFAULTS, prompt: 'Build.',
    })
  })

  test('release settings read explicit opt-outs', () => {
    const parsed = parseGroupFile('qa', '---\nreleaseOnTaskClose: false\nworktreeScoped: false\ncanReleaseMembers: false\n---\nCheck.')
    expect(parsed.ok && parsed.group).toMatchObject({
      releaseOnTaskClose: false, worktreeScoped: false, canReleaseMembers: false,
    })
  })

  test('canCreatePlans (durable-plans 3.3): true, false, missing, and an invalid value rejecting the file', () => {
    const read = (frontmatter: string) => parseGroupFile('leads', `---\n${frontmatter}\n---\nLead.`)
    expect(read('canCreatePlans: true')).toMatchObject({ ok: true, group: { canCreatePlans: true } })
    expect(read('canCreatePlans: false')).toMatchObject({ ok: true, group: { canCreatePlans: false } })
    expect(read('label: Leads')).toMatchObject({ ok: true, group: { canCreatePlans: false } })
    const invalid = read('canCreatePlans: yes')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toContain('canCreatePlans must be true or false')
  })

  test('release settings reject values other than true or false', () => {
    for (const key of ['releaseOnTaskClose', 'worktreeScoped', 'canReleaseMembers']) {
      const parsed = parseGroupFile('x', `---\n${key}: maybe\n---\nBody.`)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(`${key} must be true or false`)
    }
  })

  test('profiles list: preference order, no caps, max stays 1', () => {
    const parsed = parseGroupFile('devs', "---\nprofiles: [claude, 'glm']\n---\nBuild.")
    expect(parsed.ok && parsed.group).toMatchObject({
      profiles: [{ profileId: 'claude' }, { profileId: 'glm' }], max: 1,
    })
  })

  test('profiles map: caps in preference order, max defaults to their sum', () => {
    const parsed = parseGroupFile('devs', '---\nprofiles: { glm: 2, mimo: 1, claude: 1 }\n---\nBuild.')
    expect(parsed.ok && parsed.group).toMatchObject({
      profiles: [{ profileId: 'glm', cap: 2 }, { profileId: 'mimo', cap: 1 }, { profileId: 'claude', cap: 1 }],
      max: 4,
    })
  })

  test('an explicit max still limits a capped group', () => {
    const parsed = parseGroupFile('devs', '---\nmax: 3\nprofiles: { glm: 2, mimo: 1, claude: 1 }\n---\nBuild.')
    expect(parsed.ok && parsed.group.max).toBe(3)
  })

  test('strategy profile-order', () => {
    const parsed = parseGroupFile('devs', '---\nstrategy: profile-order\n---\nBuild.')
    expect(parsed.ok && parsed.group.strategy).toBe('profile-order')
  })

  test('onLimit: all keys', () => {
    const parsed = parseGroupFile('devs', '---\nonLimit: { parkIfResetWithin: 90m, otherwise: release, forwardTo: architects }\n---\nBuild.')
    expect(parsed.ok && parsed.group).toMatchObject({
      onLimit: { parkIfResetWithinMs: 90 * 60_000, otherwise: 'release', forwardTo: 'architects' },
      warnings: [],
    })
  })

  test('onLimit: invalid values are warnings and the defaults apply', () => {
    const parsed = parseGroupFile('devs', '---\nonLimit: { parkIfResetWithin: soon, otherwise: pause, forwardTo: "a b", extra: 1 }\n---\nBuild.')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.group.onLimit).toEqual({ parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' })
    expect(parsed.group.warnings).toHaveLength(4)
    expect(parsed.group.warnings[0]).toContain('"soon"')
    expect(parsed.group.warnings[0]).toContain('using 3h')
  })

  test('onLimit: a malformed value warns and keeps every default', () => {
    for (const raw of ['3h', '[park]', '{ parkIfResetWithin: { x: 1 } }']) {
      const parsed = parseGroupFile('devs', `---\nonLimit: ${raw}\n---\nBuild.`)
      expect(parsed.ok && parsed.group.warnings).toHaveLength(1)
      expect(parsed.ok && parsed.group.onLimit.otherwise).toBe('forward')
    }
  })

  test('effort: every level is read, quoted or not; absent is unset', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      for (const raw of [level, `"${level}"`, `'${level}'`]) {
        const parsed = parseGroupFile('devs', `---\neffort: ${raw}\n---\nBuild.`)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        expect(parsed.group.effort).toBe(level as GroupEffort)
        expect(parsed.group.warnings).toEqual([])
      }
    }
    const parsed = parseGroupFile('devs', '---\nlabel: Developers\n---\nBuild.')
    expect(parsed.ok && 'effort' in parsed.group).toBe(false)
  })

  test('effort: an invalid level warns, stays unset, and the rest of the file applies', () => {
    for (const raw of ['extreme', 'auto', 'ultracode', 'MAX', '']) {
      const parsed = parseGroupFile('devs', `---\nlabel: Developers\neffort: ${raw}\napproval: auto\n---\nBuild.`)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.group.effort).toBeUndefined()
      expect(parsed.group).toMatchObject({ label: 'Developers', approval: 'auto', prompt: 'Build.' })
      expect(parsed.group.warnings).toEqual([
        `effort must be low, medium, high, xhigh, max, got "${raw}"; ignored`,
      ])
    }
  })

  describe('profileEffort (group-profile-effort D3)', () => {
    const parse = (frontmatter: string) => {
      const parsed = parseGroupFile('juniors', `---\n${frontmatter}\n---\nJunior.`)
      if (!parsed.ok) throw new Error(parsed.error)
      return parsed.group
    }

    test('valid entries are read, quoted or not, beside the group effort', () => {
      const group = parse("effort: low\nprofileEffort: { haiku: 'xhigh', glm-flash: max }\nprofiles: [haiku, glm-flash]")
      expect(group.effort).toBe('low')
      expect(group.profileEffort).toEqual({ haiku: 'xhigh', 'glm-flash': 'max' })
      expect(group.warnings).toEqual([])
    })

    test('absent or empty is unset, without a group effort too', () => {
      expect('profileEffort' in parse('label: A')).toBe(false)
      expect('profileEffort' in parse('profileEffort: {}')).toBe(false)
      const group = parse('profileEffort: { default: high }')
      expect(group.profileEffort).toEqual({ default: 'high' })
      expect(group.effort).toBeUndefined()
    })

    test('an unknown level is ignored alone', () => {
      const group = parse('effort: low\nprofileEffort: { haiku: extreme, sonnet: high }\nprofiles: [haiku, sonnet]')
      expect(group.profileEffort).toEqual({ sonnet: 'high' })
      expect(group.warnings).toEqual([
        'profileEffort.haiku must be low, medium, high, xhigh, max, got "extreme"; ignored',
      ])
    })

    test('a key that is not a profile id is ignored alone', () => {
      const group = parse('profileEffort: { Haiku: high, sonnet: low }\nprofile: sonnet')
      expect(group.profileEffort).toEqual({ sonnet: 'low' })
      expect(group.warnings).toEqual(['profileEffort: "Haiku" is not a valid profile id; ignored'])
    })

    test('a repeated profile keeps the first and the file still parses', () => {
      const group = parse('profileEffort: { haiku: xhigh, haiku: low }\nprofile: haiku')
      expect(group.profileEffort).toEqual({ haiku: 'xhigh' })
      expect(group.warnings).toEqual(['profileEffort: "haiku" is listed twice; the later entry is ignored'])
    })

    test('the first occurrence decides: an invalid first entry is not replaced by a later valid one', () => {
      const group = parse('effort: low\nprofileEffort: { haiku: extreme, haiku: high }\nprofile: haiku')
      expect('profileEffort' in group).toBe(false)
      expect(group.effort).toBe('low')
      expect(group.warnings).toEqual([
        'profileEffort.haiku must be low, medium, high, xhigh, max, got "extreme"; ignored',
        'profileEffort: "haiku" is listed twice; the later entry is ignored',
      ])
    })

    test('a list, a bare scalar, or a malformed map ignores the whole key', () => {
      for (const raw of ['[haiku]', 'haiku', '{ haiku }', '{ haiku: high', '{ a: { b: high } }']) {
        const group = parse(`effort: low\nprofileEffort: ${raw}`)
        expect('profileEffort' in group).toBe(false)
        expect(group.effort).toBe('low')
        expect(group.warnings).toHaveLength(1)
        expect(group.warnings[0]).toStartWith('profileEffort: ')
        expect(group.warnings[0]).toEndWith('; ignored')
      }
    })

    test('an unlisted profile warns but is kept; no listed profiles means default', () => {
      const group = parse('profiles: { glm-flash: 3 }\nprofileEffort: { haiku: xhigh }')
      expect(group.profileEffort).toEqual({ haiku: 'xhigh' })
      expect(group.warnings).toEqual([
        'profileEffort: "haiku" is not one of the group\'s profiles; it applies only to members on that profile',
      ])
      const noProfiles = parse('profileEffort: { default: high, haiku: low }')
      expect(noProfiles.profileEffort).toEqual({ default: 'high', haiku: 'low' })
      expect(noProfiles.warnings).toHaveLength(1)
      expect(noProfiles.warnings[0]).toContain('"haiku"')
    })
  })

  test('profiles and onLimit still refuse a repeated map key (only profileEffort allows repeats)', () => {
    expect(parseGroupFile('g', '---\nprofiles: { glm: 2, glm: 1 }\n---\nx')).toEqual({
      ok: false, error: 'profiles: key "glm" is repeated',
    })
    const parsed = parseGroupFile('g', '---\nonLimit: { otherwise: forward, otherwise: release }\n---\nx')
    expect(parsed.ok && parsed.group.warnings).toEqual(['onLimit: key "otherwise" is repeated; using defaults'])
    expect(parsed.ok && parsed.group.onLimit.otherwise).toBe('forward')
  })

  test('parseDuration', () => {
    expect(parseDuration('90m')).toBe(5_400_000)
    expect(parseDuration('3h')).toBe(10_800_000)
    for (const bad of ['0h', '1d', 'h', '1.5h', 'soon']) expect(parseDuration(bad)).toBeNull()
  })
})

describe('canManageMailbox', () => {
  const parse = (value?: string) => parseGroupFile('lead', `---\n${value === undefined ? '' : `canManageMailbox: ${value}\n`}---\nLead.`)

  test('true, false, and absent', () => {
    for (const [value, expected] of [['true', true], ['false', false], [undefined, false]] as const) {
      const parsed = parse(value)
      expect(parsed.ok && parsed.group).toMatchObject({ canManageMailbox: expected, warnings: [] })
    }
  })

  test('an invalid value is a warning that keeps the group and the right off', () => {
    const parsed = parse('maybe')
    expect(parsed.ok && parsed.group).toMatchObject({ canManageMailbox: false, prompt: 'Lead.' })
    expect(parsed.ok && parsed.group.warnings).toEqual(['canManageMailbox must be true or false, got "maybe"; ignored'])
  })
})
