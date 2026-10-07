import { describe, expect, test } from 'bun:test'
import { relativeToProject, toolCallDetail } from '../components/chat/toolCallLabel'

describe('toolCallDetail', () => {
  test('each mapped tool shows its key field', () => {
    const cases: Array<[tool: string, input: Record<string, unknown>, expected: string]> = [
      ['Read', { file_path: '/repo/src/index.ts' }, '/repo/src/index.ts'],
      ['Write', { file_path: '/repo/out.ts', content: 'x' }, '/repo/out.ts'],
      ['Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, '/repo/a.ts'],
      ['NotebookEdit', { notebook_path: '/repo/nb.ipynb' }, '/repo/nb.ipynb'],
      ['Bash', { command: 'ls' }, 'ls'],
      ['Glob', { pattern: '*.ts' }, '*.ts'],
      ['Grep', { pattern: 'TODO' }, 'TODO'],
      ['WebFetch', { url: 'https://example.com' }, 'https://example.com'],
      ['WebSearch', { query: 'bun test runner' }, 'bun test runner'],
      ['Agent', { description: 'research npm options' }, 'research npm options'],
      ['Task', { description: 'fix the flaky test' }, 'fix the flaky test'],
      ['Skill', { skill: 'dataviz' }, 'dataviz'],
    ]
    for (const [tool, input, expected] of cases) {
      expect(toolCallDetail(tool, input)).toBe(expected)
    }
  })

  test('Bash prefers its description and falls back to its command', () => {
    expect(toolCallDetail('Bash', { description: 'Run unit tests', command: 'bun test' })).toBe('Run unit tests')
    expect(toolCallDetail('Bash', { command: 'bun test' })).toBe('bun test')
    expect(toolCallDetail('Bash', { description: '   ', command: 'bun test' })).toBe('bun test')
    expect(toolCallDetail('Bash', { description: 3, command: 'bun test' })).toBe('bun test')
  })

  test('Bash with both fields unusable yields no detail', () => {
    expect(toolCallDetail('Bash', {})).toBeNull()
    expect(toolCallDetail('Bash', { description: ' ', command: '' })).toBeNull()
    expect(toolCallDetail('Bash', { description: null, command: ['ls'] })).toBeNull()
  })

  test('unknown tools such as MCP tools yield no detail', () => {
    expect(toolCallDetail('mcp__github__create_issue', { title: 'Fix the thing' })).toBeNull()
    expect(toolCallDetail('TodoWrite', { todos: [] })).toBeNull()
  })

  test('unusable field values yield no detail only when every eligible field fails', () => {
    expect(toolCallDetail('Read', {})).toBeNull()
    expect(toolCallDetail('Read', { file_path: ' ' })).toBeNull()
    expect(toolCallDetail('Read', { file_path: 42 })).toBeNull()
    expect(toolCallDetail('Read', { file_path: undefined })).toBeNull()
    expect(toolCallDetail('Skill', undefined)).toBeNull()
    expect(toolCallDetail('Bash', { description: 'Lint', command: undefined })).toBe('Lint')
  })

  test('line breaks collapse so the detail stays on one line', () => {
    expect(toolCallDetail('Bash', { command: 'bun run lint\nbun run test' })).toBe('bun run lint bun run test')
    expect(toolCallDetail('Bash', { command: ' \r\n bun test \n ' })).toBe('bun test')
  })

  test('path fields are made relative to the project', () => {
    expect(toolCallDetail('Read', { file_path: '/repo/src/index.ts' }, '/repo')).toBe('src/index.ts')
    expect(toolCallDetail('Read', { file_path: '/etc/hosts' }, '/repo')).toBe('/etc/hosts')
  })
})

describe('relativeToProject', () => {
  test('a path inside the project becomes relative', () => {
    expect(relativeToProject('/repo/src/index.ts', '/repo')).toBe('src/index.ts')
    expect(relativeToProject('/repo/a/b/c.ts', '/repo/')).toBe('a/b/c.ts')
  })

  test('a path outside the project is unchanged', () => {
    expect(relativeToProject('/etc/hosts', '/repo')).toBe('/etc/hosts')
  })

  test('a sibling directory sharing only a name prefix is unchanged', () => {
    expect(relativeToProject('/repo-other/a.ts', '/repo')).toBe('/repo-other/a.ts')
  })

  test('a path equal to the project shows . in all trailing-slash combinations', () => {
    for (const project of ['/repo', '/repo/']) {
      for (const path of ['/repo', '/repo/']) {
        expect(relativeToProject(path, project)).toBe('.')
      }
    }
  })

  test('without a project path, paths are unchanged', () => {
    expect(relativeToProject('/repo/src/index.ts')).toBe('/repo/src/index.ts')
    expect(relativeToProject('/repo/src/index.ts', '')).toBe('/repo/src/index.ts')
  })

  test('relative inputs stay as they are and the root project strips its slash', () => {
    expect(relativeToProject('src/index.ts', '/repo')).toBe('src/index.ts')
    expect(relativeToProject('/etc/hosts', '/')).toBe('etc/hosts')
    expect(relativeToProject('/', '/')).toBe('.')
  })
})
