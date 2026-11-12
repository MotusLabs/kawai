// The A19 projection rules of codex/events.ts (task-ce05430a R3/R4) at the
// boundaries Kawai's root mapping had and its event cases never reached: a
// one-file change reads "file", several "files" in their order; a dynamic
// tool's content joins its text items by newline with a `[type]` placeholder
// for any other item, and no content is an empty result; an MCP failure
// without a message keeps the package's result rendering. Expected strings
// are written from those rules, never read from the mapping.
import { describe, expect, test } from 'bun:test'
import { mapCodexNotification } from '../src/codex/events.js'

const completed = (item: Record<string, unknown>) =>
  mapCodexNotification('item/completed', { item }, 'turn-1').flatMap((output) => (output.kind === 'event' ? [output.body] : []))

describe('codex event projection (A19)', () => {
  test('a completed file change names its files with the right count word, in order', () => {
    const change = (...paths: string[]) => ({ type: 'fileChange', id: 'fc', status: 'completed', changes: paths.map((path) => ({ path, kind: { type: 'add' }, diff: '' })) })
    expect(completed(change('only.ts'))[0]).toMatchObject({ output: 'Changed 1 file: only.ts', isError: false })
    expect(completed(change('c.ts', 'a.ts', 'b.ts'))[0]).toMatchObject({ output: 'Changed 3 files: c.ts, a.ts, b.ts', isError: false })
    expect(completed({ ...change('x.ts'), status: 'failed' })[0]).toMatchObject({ output: 'The file change failed.', isError: true })
  })

  test("a dynamic tool's text items join by newline; other items are placeholders; none is empty", () => {
    const dynamic = (contentItems: unknown) => ({ type: 'dynamicToolCall', id: 'd', namespace: 'kawai-team', tool: 't', status: 'completed', success: true, contentItems })
    expect(completed(dynamic([{ type: 'inputText', text: 'a' }, { type: 'inputImage', imageUrl: 'u' }, { type: 'inputText', text: 'b' }]))[0])
      .toMatchObject({ output: 'a\n[inputImage]\nb', isError: false })
    expect(completed(dynamic(null))[0]).toMatchObject({ output: '' })
    expect(completed({ ...dynamic([{ type: 'inputText', text: 'no' }]), success: false })[0]).toMatchObject({ output: 'no', isError: true })
  })

  test('an MCP failure reads its message; without one the result renders as before', () => {
    const mcp = { type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'failed', arguments: {}, result: null }
    expect(completed({ ...mcp, error: { message: 'boom' } })[0]).toMatchObject({ output: 'boom', isError: true })
    expect(completed({ ...mcp, error: null })[0]).toMatchObject({ output: 'null', isError: true })
    expect(completed({ ...mcp, status: 'completed', error: null, result: { content: [{ type: 'text', text: 'ok' }] } })[0])
      .toMatchObject({ output: '{"content":[{"type":"text","text":"ok"}]}', isError: false })
  })
})
