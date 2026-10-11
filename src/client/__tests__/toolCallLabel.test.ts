import { describe, expect, test } from 'bun:test'
import { relativeToProject, toolCallDetail } from '../components/chat/toolCallLabel'

describe('toolCallDetail', () => {
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
      expect(toolCallDetail(tool, input)).toBe(expected)
    }
  })

  test('Bash prefers description and falls back to a usable command', () => {
    expect(toolCallDetail('Bash', { description: 'Run unit tests', command: 'bun test' })).toBe('Run unit tests')
    expect(toolCallDetail('Bash', { command: 'bun test' })).toBe('bun test')
    expect(toolCallDetail('Bash', { description: 'Run unit tests' })).toBe('Run unit tests')
    expect(toolCallDetail('Bash', { description: '   ', command: 'bun test' })).toBe('bun test')
    expect(toolCallDetail('Bash', { description: 3, command: 'bun test' })).toBe('bun test')
  })

  test('Bash with both fields unusable yields no detail', () => {
    expect(toolCallDetail('Bash', {})).toBeNull()
    expect(toolCallDetail('Bash', { description: ' ', command: '' })).toBeNull()
    expect(toolCallDetail('Bash', { description: null, command: ['ls'] })).toBeNull()
  })

  test('TaskUpdate formats the task id and status, dropping a missing half', () => {
    expect(toolCallDetail('TaskUpdate', { taskId: '1', status: 'in_progress' })).toBe('Task 1 → in_progress')
    expect(toolCallDetail('TaskUpdate', { taskId: '1' })).toBe('Task 1')
    expect(toolCallDetail('TaskUpdate', { status: 'completed' })).toBe('→ completed')
    expect(toolCallDetail('TaskUpdate', {})).toBeNull()
    expect(toolCallDetail('TaskUpdate', { taskId: ' ', status: '' })).toBeNull()
  })

  test('AskUserQuestion formats the first header with a count past one question', () => {
    const question = (header: string) => ({ question: `Which ${header}?`, header, options: [] })
    expect(toolCallDetail('AskUserQuestion', { questions: [question('Spec sync')] })).toBe('Spec sync')
    expect(toolCallDetail('AskUserQuestion', { questions: [question('Spec sync'), question('Archive')] })).toBe('Spec sync · 2 questions')
    expect(toolCallDetail('AskUserQuestion', { questions: [{ ...question(''), options: [] }] })).toBeNull()
    expect(toolCallDetail('AskUserQuestion', { questions: [] })).toBeNull()
    expect(toolCallDetail('AskUserQuestion', {})).toBeNull()
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
    expect(toolCallDetail('EnterWorktree', { path: ' ', name: 'docs' })).toBe('docs')
  })

  test('line breaks collapse so the detail stays on one line', () => {
    expect(toolCallDetail('Bash', { command: 'bun run lint\nbun run test' })).toBe('bun run lint bun run test')
    expect(toolCallDetail('Bash', { command: ' \r\n bun test \n ' })).toBe('bun test')
    expect(toolCallDetail('Bash', { description: 'Lint\ntypecheck', command: 'bun x' })).toBe('Lint typecheck')
  })

  test('path fields are made relative to the project', () => {
    expect(toolCallDetail('Read', { file_path: '/repo/src/index.ts' }, '/repo')).toBe('src/index.ts')
    expect(toolCallDetail('Read', { file_path: '/etc/hosts' }, '/repo')).toBe('/etc/hosts')
    expect(toolCallDetail('EnterWorktree', { path: '/repo/.worktrees/docs' }, '/repo')).toBe('.worktrees/docs')
    // `name` is never treated as a path, even when it looks like one.
    expect(toolCallDetail('EnterWorktree', { name: '/repo/docs' }, '/repo')).toBe('/repo/docs')
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
