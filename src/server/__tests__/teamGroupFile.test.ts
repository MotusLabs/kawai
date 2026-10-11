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
        prompt: 'You review designs.\n\nKeep answers short.',
      },
    })
  })

  test('a body-only file defaults the label to the id', () => {
    expect(parseGroupFile('qa', 'Test everything.\n')).toEqual({
      ok: true,
      group: { id: 'qa', label: 'qa', description: '', prompt: 'Test everything.' },
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
    ] as const) {
      const parsed = parseGroupFile('x', content)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(error)
    }
  })
})
