import { describe, expect, test } from 'bun:test'
import TestRenderer, { type ReactTestInstance } from 'react-test-renderer'
import type { ElementType } from 'react'
import Markdown from '../components/Markdown'

function render(content: string) {
  const renderer = TestRenderer.create(<Markdown content={content} />)
  const root = renderer.root
  const byType = (type: string) => root.findAllByType(type as ElementType)
  const first = (type: string): ReactTestInstance => {
    const found = byType(type)
    if (!found.length) throw new Error(`no <${type}> rendered`)
    return found[0]!
  }
  const html = () => JSON.stringify(renderer.toJSON())
  const textOf = (node: ReactTestInstance): string =>
    node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('')
  return { root, byType, first, html, textOf, unmount: () => renderer.unmount() }
}

const classNameOf = (node: ReactTestInstance) => String(node.props.className ?? '')

describe('shared markdown renderer', () => {
  test('renders headings, lists, blockquote, rule and fenced code blocks', () => {
    const { first, byType, textOf, unmount } = render(
      '# Title\n\n## Subtitle\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n\n```ts\nconst x = 1\n```',
    )
    expect(classNameOf(first('h1'))).toContain('text-base')
    expect(classNameOf(first('h2'))).toContain('font-semibold')
    expect(classNameOf(first('ul'))).toContain('list-disc')
    expect(classNameOf(first('ol'))).toContain('list-decimal')
    expect(classNameOf(first('blockquote'))).toContain('border-l-2')
    expect(byType('hr')).toHaveLength(1)
    const pre = first('pre')
    expect(classNameOf(pre)).toContain('overflow-x-auto')
    expect(textOf(pre)).toContain('const x = 1')
    unmount()
  })

  test('renders inline emphasis, code chips and safe links', () => {
    const { first, byType, unmount } = render(
      '**bold** and *italic* and `code` and https://example.com and [a link](https://example.org)',
    )
    expect(first('strong').children).toEqual(['bold'])
    expect(first('em').children).toEqual(['italic'])
    expect(classNameOf(first('code'))).toContain('rounded')
    const links = byType('a')
    expect(links).toHaveLength(2)
    expect(links[1]!.props.href).toBe('https://example.org')
    for (const link of links) {
      expect(link.props.target).toBe('_blank')
      expect(String(link.props.rel)).toContain('noopener')
    }
    unmount()
  })

  test('resets nested code styling for a one-line fenced block with no language', () => {
    const { first, unmount } = render('```\nplain block\n```')
    const pre = first('pre')
    expect(classNameOf(pre)).toContain('[&>code]:bg-transparent')
    expect(classNameOf(pre)).toContain('[&>code]:p-0')
    expect(classNameOf(pre)).toContain('[&>code]:text-inherit')
    unmount()
  })

  test('renders strikethrough and deep headings with styles', () => {
    const { first, unmount } = render('~~gone~~ and\n\n#### deep heading')
    const del = first('del')
    expect(classNameOf(del)).toContain('line-through')
    expect(classNameOf(del)).toContain('text-secondary')
    expect(del.children).toEqual(['gone'])
    expect(classNameOf(first('h4'))).toContain('font-semibold')
    unmount()
  })

  test('renders task lists with disabled checkboxes and no markers on task items', () => {
    const { byType, unmount } = render('- [ ] a\n- [x] b')
    const items = byType('li')
    expect(items.map(item => classNameOf(item))).toEqual([
      expect.stringContaining('list-none'),
      expect.stringContaining('list-none'),
    ])
    expect(classNameOf(items[0]!)).toContain('task-list-item')
    const checkboxes = byType('input')
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes.map(box => box.props.disabled)).toEqual([true, true])
    expect(checkboxes.map(box => box.props.checked)).toEqual([false, true])
    unmount()
  })

  test('keeps markers on ordinary items in a mixed task list', () => {
    for (const [source, tag, marker] of [
      ['- plain\n- [ ] task', 'ul', 'list-disc'],
      ['1. plain\n2. [x] task', 'ol', 'list-decimal'],
    ] as const) {
      const { first, byType, unmount } = render(source)
      expect(classNameOf(first(tag))).toContain(marker)
      const [plain, task] = byType('li').map(item => classNameOf(item))
      expect(plain).not.toContain('list-none')
      expect(task).toContain('list-none')
      unmount()
    }
  })

  test('preserves an ordered list starting number', () => {
    const { first, unmount } = render('3. third\n4. fourth')
    expect(first('ol').props.start).toBe(3)
    unmount()
  })

  test('renders GFM tables with a header row', () => {
    const { first, unmount } = render('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(classNameOf(first('table'))).toContain('border-collapse')
    expect(classNameOf(first('th'))).toContain('font-semibold')
    expect(first('th').children).toEqual(['a'])
    expect(first('td').children).toEqual(['1'])
    unmount()
  })

  test('keeps single line breaks', () => {
    const { byType, unmount } = render('first line\nsecond line')
    expect(byType('br')).toHaveLength(1)
    unmount()
  })

  test('keeps raw HTML inert', () => {
    const { byType, html, unmount } = render('hello <script>bad()</script> world')
    // The tag is escaped into literal text; no script element is created.
    expect(byType('script')).toHaveLength(0)
    expect(html()).not.toContain('"type":"script"')
    unmount()
  })
})
