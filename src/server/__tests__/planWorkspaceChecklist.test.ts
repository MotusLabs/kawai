// plan-workspace 2.2 tests: the Markdown task projection — source order and
// nesting, inert fenced examples, positional keys over duplicate numbering,
// and key identity bound to the source content hash.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { projectChecklist } from '../plans/workspace/checklistProjection'

const hashOf = (markdown: string): string => createHash('sha256').update(markdown).digest('hex')

describe('projectChecklist', () => {
  test('sections and mixed checked/unchecked items project in source order with nesting', () => {
    const markdown = '# Alpha\n\n- [x] one\n- [ ] two\n  - [ ] two-sub\n\n## Beta\n\n- [ ] three\n'
    const hash = hashOf(markdown)
    const projection = projectChecklist(markdown, hash)
    expect(projection.sourceHash).toBe(hash)
    expect(projection.sections).toEqual([
      {
        heading: 'Alpha',
        depth: 1,
        items: [
          { key: `${hash}:3`, text: 'one', checked: true, line: 3, depth: 1 },
          { key: `${hash}:4`, text: 'two', checked: false, line: 4, depth: 1 },
          { key: `${hash}:5`, text: 'two-sub', checked: false, line: 5, depth: 2 },
        ],
      },
      {
        heading: 'Beta',
        depth: 2,
        items: [{ key: `${hash}:9`, text: 'three', checked: false, line: 9, depth: 1 }],
      },
    ])
  })

  test('checkboxes inside fenced code are not items', () => {
    const markdown = '```md\n- [x] not an item\n- [ ] also not\n```\n'
    const projection = projectChecklist(markdown, hashOf(markdown))
    // The fence is a code node; its content is never tokenized.
    expect(projection.sections).toEqual([])
  })

  test('duplicate task numbering stays distinct positional items', () => {
    const markdown = '# Tasks\n\n- [ ] 1. first\n- [ ] 1. second\n'
    const hash = hashOf(markdown)
    const projection = projectChecklist(markdown, hash)
    expect(projection.sections[0]!.items).toEqual([
      { key: `${hash}:3`, text: '1. first', checked: false, line: 3, depth: 1 },
      { key: `${hash}:4`, text: '1. second', checked: false, line: 4, depth: 1 },
    ])
    // Identity is the source position, never the number in the text.
    expect(new Set(projection.sections[0]!.items.map(item => item.key)).size).toBe(2)
  })

  test('a changed artifact changes the source hash its keys are local to', () => {
    const before = '# Tasks\n\n- [ ] one\n'
    const after = '# Tasks\n\n- [x] one\n'
    const first = projectChecklist(before, hashOf(before))
    const second = projectChecklist(after, hashOf(after))
    expect(second.sourceHash).not.toBe(first.sourceHash)
    expect(second.sections[0]!.items[0]!.key).not.toBe(first.sections[0]!.items[0]!.key)
    expect(second.sections[0]!.items[0]!.checked).toBe(true)
  })

  test('an unchanged artifact keeps its source hash', () => {
    const markdown = '# Tasks\n\n- [x] one\n- [ ] two\n'
    const hash = hashOf(markdown)
    expect(projectChecklist(markdown, hash)).toEqual(projectChecklist(markdown, hash))
    expect(projectChecklist(markdown, hash).sourceHash).toBe(hash)
  })
})
