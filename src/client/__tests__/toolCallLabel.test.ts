import { describe, expect, test } from 'bun:test'
import { relativeToProject, toolCallHandle } from '../components/chat/toolCallLabel'

describe('toolCallHandle', () => {
  test('each mapped tool shows its key field', () => {
    const cases: Array<[tool: string, input: Record<string, unknown>, expected: string]> = [
      ['Read', { file_path: '/repo/src/index.ts' }, '/repo/src/index.ts'],
      ['Write', { file_path: '/repo/out.ts', content: 'line' }, '/repo/out.ts'],
      ['Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, '/repo/a.ts'],
      ['NotebookEdit', { notebook_path: '/repo/nb.ipynb' }, '/repo/nb.ipynb'],
      ['Bash', { command: 'ls' }, 'ls'],
      ['Glob', { pattern: '*.ts' }, '*.ts'],
      ['Grep', { pattern: 'TODO' }, 'TODO'],
      ['WebFetch', { url: 'https://example.com' }, 'https://example.com'],
      ['WebSearch', { query: 'bun test runner' }, 'bun test runner'],
      ['ToolSearch', { query: 'browser tools' }, 'browser tools'],
      ['Agent', { description: 'research npm options' }, 'research npm options'],
      ['Task', { description: 'fix the flaky test' }, 'fix the flaky test'],
      ['Monitor', { description: 'watch deploy.log for errors' }, 'watch deploy.log for errors'],
      ['Skill', { skill: 'dataviz' }, 'dataviz'],
      ['TaskCreate', { subject: 'Add auth' }, 'Add auth'],
      ['TaskStop', { task_id: 'task-123' }, 'task-123'],
      ['TaskOutput', { task_id: 'task-123' }, 'task-123'],
      ['EnterWorktree', { path: '/repo/.worktrees/docs' }, '/repo/.worktrees/docs'],
      ['EnterWorktree', { name: 'docs' }, 'docs'],
      ['ExitPlanMode', { planFilePath: '/repo/.claude/plans/p.md', plan: '# Whole document' }, '/repo/.claude/plans/p.md'],
    ]
    for (const [tool, input, expected] of cases) {
      expect(toolCallHandle(tool, input)).toBe(expected)
    }
  })

  test('Bash shows its description, falling back to its command', () => {
    expect(toolCallHandle('Bash', { description: 'Run unit tests', command: 'bun test' })).toBe('Run unit tests')
    expect(toolCallHandle('Bash', { command: 'bun test' })).toBe('bun test')
    expect(toolCallHandle('Bash', { description: 'Run unit tests' })).toBe('Run unit tests')
    expect(toolCallHandle('Bash', { description: '   ', command: 'bun test' })).toBe('bun test')
    expect(toolCallHandle('Bash', { description: 3, command: 'bun test' })).toBe('bun test')
  })

  test('Bash never composes the description with the command', () => {
    expect(toolCallHandle('Bash', { description: 'Run unit tests', command: 'bun test' })).not.toContain('bun test')
  })

  test('Bash with both fields unusable yields no handle', () => {
    expect(toolCallHandle('Bash', {})).toBeNull()
    expect(toolCallHandle('Bash', { description: ' ', command: '' })).toBeNull()
    expect(toolCallHandle('Bash', { description: null, command: ['ls'] })).toBeNull()
  })

  test('TaskUpdate formats the task id and status, dropping a missing half', () => {
    expect(toolCallHandle('TaskUpdate', { taskId: '1', status: 'in_progress' })).toBe('Task 1 → in_progress')
    expect(toolCallHandle('TaskUpdate', { taskId: '1' })).toBe('Task 1')
    expect(toolCallHandle('TaskUpdate', { status: 'completed' })).toBe('→ completed')
    expect(toolCallHandle('TaskUpdate', {})).toBeNull()
    expect(toolCallHandle('TaskUpdate', { taskId: ' ', status: '' })).toBeNull()
  })

  test('AskUserQuestion formats the first header with a count past one question', () => {
    const question = (header: string) => ({ question: `Which ${header}?`, header, options: [] })
    expect(toolCallHandle('AskUserQuestion', { questions: [question('Spec sync')] })).toBe('Spec sync')
    expect(toolCallHandle('AskUserQuestion', { questions: [question('Spec sync'), question('Archive')] })).toBe('Spec sync · 2 questions')
    expect(toolCallHandle('AskUserQuestion', { questions: [{ ...question(''), options: [] }] })).toBeNull()
    expect(toolCallHandle('AskUserQuestion', { questions: [] })).toBeNull()
    expect(toolCallHandle('AskUserQuestion', {})).toBeNull()
  })

  test('unknown tools such as MCP tools yield no handle', () => {
    expect(toolCallHandle('mcp__github__create_issue', { title: 'Fix the thing' })).toBeNull()
    expect(toolCallHandle('TodoWrite', { todos: [] })).toBeNull()
  })

  test('unusable field values yield no handle only when every eligible field fails', () => {
    expect(toolCallHandle('Read', {})).toBeNull()
    expect(toolCallHandle('Read', { file_path: ' ' })).toBeNull()
    expect(toolCallHandle('Read', { file_path: 42 })).toBeNull()
    expect(toolCallHandle('Read', { file_path: undefined })).toBeNull()
    expect(toolCallHandle('Skill', undefined)).toBeNull()
    expect(toolCallHandle('EnterWorktree', { path: ' ', name: 'docs' })).toBe('docs')
  })

  test('line breaks collapse so the handle stays on one line', () => {
    expect(toolCallHandle('Bash', { command: 'bun run lint\nbun run test' })).toBe('bun run lint bun run test')
    expect(toolCallHandle('Bash', { command: ' \r\n bun test \n ' })).toBe('bun test')
    expect(toolCallHandle('Bash', { description: 'Lint\ntypecheck', command: 'bun x' })).toBe('Lint typecheck')
  })

  test('path fields are made relative to the project', () => {
    expect(toolCallHandle('Read', { file_path: '/repo/src/index.ts' }, '/repo')).toBe('src/index.ts')
    expect(toolCallHandle('Read', { file_path: '/etc/hosts' }, '/repo')).toBe('/etc/hosts')
    expect(toolCallHandle('EnterWorktree', { path: '/repo/.worktrees/docs' }, '/repo')).toBe('.worktrees/docs')
    // `name` is never treated as a path, even when it looks like one.
    expect(toolCallHandle('EnterWorktree', { name: '/repo/docs' }, '/repo')).toBe('/repo/docs')
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
