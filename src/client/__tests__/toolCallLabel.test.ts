import { describe, expect, test } from 'bun:test'
import { relativeToProject, toolCallDetail, toolResultDetail } from '../components/chat/toolCallLabel'

describe('toolCallDetail', () => {
  test('each mapped tool shows its key field', () => {
    const cases: Array<[tool: string, input: Record<string, unknown>, expected: string]> = [
      ['Read', { file_path: '/repo/src/index.ts' }, '/repo/src/index.ts'],
      ['Write', { file_path: '/repo/out.ts', content: 'line' }, '/repo/out.ts +1'],
      ['Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, '/repo/a.ts +1 −1'],
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

  test('Bash composes description and command, dropping unusable parts', () => {
    expect(toolCallDetail('Bash', { description: 'Run unit tests', command: 'bun test' })).toBe('Run unit tests — bun test')
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
    expect(toolCallDetail('Bash', { description: 'Lint\ntypecheck', command: 'bun x' })).toBe('Lint typecheck — bun x')
  })

  test('path fields are made relative to the project', () => {
    expect(toolCallDetail('Read', { file_path: '/repo/src/index.ts' }, '/repo')).toBe('src/index.ts')
    expect(toolCallDetail('Read', { file_path: '/etc/hosts' }, '/repo')).toBe('/etc/hosts')
    expect(toolCallDetail('EnterWorktree', { path: '/repo/.worktrees/docs' }, '/repo')).toBe('.worktrees/docs')
    // `name` is never treated as a path, even when it looks like one.
    expect(toolCallDetail('EnterWorktree', { name: '/repo/docs' }, '/repo')).toBe('/repo/docs')
  })

  test('Edit and Write append a git-style line delta', () => {
    expect(toolCallDetail('Edit', { file_path: '/repo/a.ts', old_string: 'a\nb\nc', new_string: '1\n2\n3\n4\n5' })).toBe('/repo/a.ts +5 −3')
    expect(toolCallDetail('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })).toBe('/repo/a.ts +1 −1')
    // A trailing newline does not add a line.
    expect(toolCallDetail('Edit', { file_path: '/repo/a.ts', old_string: 'a\nb\nc', new_string: 'a\nb\nc\n' })).toBe('/repo/a.ts +3 −3')
    // Deletion-only keeps the removed side alone.
    expect(toolCallDetail('Edit', { file_path: '/repo/a.ts', old_string: 'a\nb', new_string: '' })).toBe('/repo/a.ts −2')
    // Write counts additions only, from `content`.
    expect(toolCallDetail('Write', { file_path: '/repo/out.ts', content: 'x\ny\nz\n' })).toBe('/repo/out.ts +3')
    expect(toolCallDetail('Write', { file_path: '/repo/out.ts', content: '' })).toBe('/repo/out.ts')
    // Both sides zero: no delta at all.
    expect(toolCallDetail('Edit', { file_path: '/repo/a.ts', old_string: '', new_string: '' })).toBe('/repo/a.ts')
    // replace_all reports the per-replacement change.
    expect(toolCallDetail('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'bb', replace_all: true })).toBe('/repo/a.ts +1 −1')
    // No usable path means no detail, delta included.
    expect(toolCallDetail('Edit', { old_string: 'a', new_string: 'b' })).toBeNull()
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

describe('toolResultDetail', () => {
  test('the hint is the first non-blank line, on one line', () => {
    expect(toolResultDetail('\n\n  Task #1 created successfully: Run 6.3\nnext line')).toBe('Task #1 created successfully: Run 6.3')
    expect(toolResultDetail('Command failed: bun test\n    at test.ts:1:1')).toBe('Command failed: bun test')
    expect(toolResultDetail('single line')).toBe('single line')
    expect(toolResultDetail('ok\r\nsecond')).toBe('ok')
  })

  test('an output with no non-blank line yields no hint', () => {
    expect(toolResultDetail('')).toBeNull()
    expect(toolResultDetail(' \n\t\n')).toBeNull()
  })
})
