import { describe, expect, test } from 'bun:test'
import { parseGroupFile } from '../team/groupFile'

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
        max: 1,
        approval: 'manual',
        prompt: 'You review designs.\n\nKeep answers short.',
      },
    })
  })

  test('a body-only file defaults the label to the id', () => {
    expect(parseGroupFile('qa', 'Test everything.\n')).toEqual({
      ok: true,
      group: { id: 'qa', label: 'qa', description: '', canCreateTasks: false, max: 1, approval: 'manual', prompt: 'Test everything.' },
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
    expect(parsed.ok && parsed.group).toMatchObject({ canCreateTasks: true, max: 3, profile: 'glm', approval: 'auto' })
  })

  test('task settings default to no creation right, one member, default profile, manual approval', () => {
    const parsed = parseGroupFile('devs', '---\ncanCreateTasks: false\n---\nBuild.')
    expect(parsed.ok && parsed.group).toEqual({
      id: 'devs', label: 'devs', description: '', canCreateTasks: false, max: 1, approval: 'manual', prompt: 'Build.',
    })
  })
})
