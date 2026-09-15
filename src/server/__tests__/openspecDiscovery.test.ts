// openspecDiscovery.test.ts - Task 3.1 coverage: per-worktree openspec list
// discovery with timeouts, bounded output, missing-root handling, and
// defensive parsing — active, archived, missing-progress, malformed, failed.
import { describe, expect, test } from 'bun:test'
import type { OpenspecCommandResult } from '../workspace/openspecDiscovery'
import {
  discoverWorktreeOpenSpec,
  parseOpenSpecChangeEntry,
  parseOpenspecListOutput,
} from '../workspace/openspecDiscovery'

function runnerReturning(result: Partial<OpenspecCommandResult>) {
  return (): OpenspecCommandResult => ({
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: '',
    ...result,
  })
}

const activeChangePayload = {
  changes: [
    {
      name: 'add-auth',
      completedTasks: 3,
      totalTasks: 11,
      lastModified: '2026-01-02T03:04:05.000Z',
      status: 'in-progress',
    },
    {
      name: 'local-k8s-runner-workflows',
      completedTasks: 9,
      totalTasks: 11,
      lastModified: '2026-01-03T03:04:05.000Z',
      status: 'in-progress',
    },
  ],
  root: { path: '/repo/openspec', source: 'nearest' },
}

describe('parseOpenSpecChangeEntry', () => {
  test('keeps name and optional fields when present', () => {
    expect(
      parseOpenSpecChangeEntry({ name: 'x', status: 'in-progress', completedTasks: 1, totalTasks: 2, lastModified: 't' })
    ).toEqual({ name: 'x', status: 'in-progress', completedTasks: 1, totalTasks: 2, lastModified: 't' })
  })

  test('missing progress fields do not invent values', () => {
    expect(parseOpenSpecChangeEntry({ name: 'x' })).toEqual({ name: 'x' })
    expect(parseOpenSpecChangeEntry({ name: 'x', completedTasks: null, totalTasks: 'many' })).toEqual({ name: 'x' })
  })

  test('rejects entries without a name', () => {
    expect(parseOpenSpecChangeEntry(null)).toBeNull()
    expect(parseOpenSpecChangeEntry({ status: 'in-progress' })).toBeNull()
    expect(parseOpenSpecChangeEntry({ name: '' })).toBeNull()
  })
})

describe('parseOpenspecListOutput', () => {
  test('parses active changes with root path', () => {
    const parsed = parseOpenspecListOutput(JSON.stringify(activeChangePayload))
    expect(parsed?.rootPath).toBe('/repo/openspec')
    expect(parsed?.changes).toHaveLength(2)
    expect(parsed?.changes[0]).toEqual({
      name: 'add-auth',
      status: 'in-progress',
      completedTasks: 3,
      totalTasks: 11,
      lastModified: '2026-01-02T03:04:05.000Z',
    })
  })

  test('archived changes are absent from active listing', () => {
    // openspec list returns only active changes; an archived change simply
    // disappears from the payload.
    const archivedPayload = {
      changes: [activeChangePayload.changes[0]],
      root: { path: '/repo/openspec' },
    }
    const parsed = parseOpenspecListOutput(JSON.stringify(archivedPayload))
    expect(parsed?.changes.map((change) => change.name)).toEqual(['add-auth'])
  })

  test('malformed JSON returns null', () => {
    expect(parseOpenspecListOutput('not json{')).toBeNull()
    expect(parseOpenspecListOutput('')).toBeNull()
  })

  test('payload without a changes array returns null', () => {
    expect(parseOpenspecListOutput('{"root":null}')).toBeNull()
  })

  test('null root parses without rootPath', () => {
    const parsed = parseOpenspecListOutput('{"changes":[],"root":null}')
    expect(parsed).toEqual({ changes: [] })
    expect(parsed?.rootPath).toBeUndefined()
  })
})

describe('discoverWorktreeOpenSpec', () => {
  test('active changes become a fresh non-stale state', () => {
    const state = discoverWorktreeOpenSpec('/repo', {
      runner: runnerReturning({ ok: true, exitCode: 0, stdout: JSON.stringify(activeChangePayload) }),
    })
    expect(state.stale).toBe(false)
    expect(state.rootPath).toBe('/repo/openspec')
    expect(state.changes.map((change) => change.name)).toEqual(['add-auth', 'local-k8s-runner-workflows'])
  })

  test('missing root produces an empty non-error state', () => {
    const state = discoverWorktreeOpenSpec('/repo', {
      runner: runnerReturning({
        ok: false,
        exitCode: 1,
        stdout: JSON.stringify({
          changes: [],
          root: null,
          status: [
            {
              severity: 'error',
              code: 'no_openspec_root',
              message: 'No OpenSpec root found from the current directory.',
            },
          ],
        }),
      }),
    })
    expect(state).toEqual({ changes: [], stale: false })
    expect(state.error).toBeUndefined()
  })

  test('command failure produces a stale error state', () => {
    const state = discoverWorktreeOpenSpec('/repo', {
      runner: runnerReturning({ ok: false, exitCode: 127, stderr: 'openspec: not found' }),
    })
    expect(state.stale).toBe(true)
    expect(state.error).toBe('openspec exited with 127')
    expect(state.changes).toEqual([])
  })

  test('timeout produces a stale error state', () => {
    const state = discoverWorktreeOpenSpec('/repo', {
      runner: runnerReturning({ ok: false, exitCode: null }),
    })
    expect(state.stale).toBe(true)
    expect(state.error).toBe('openspec timed out')
  })

  test('malformed success output produces a stale error state', () => {
    const state = discoverWorktreeOpenSpec('/repo', {
      runner: runnerReturning({ ok: true, exitCode: 0, stdout: 'garbage' }),
    })
    expect(state.stale).toBe(true)
    expect(state.error).toBe('Unparseable openspec output')
  })

  test('missing-progress payload keeps name and status only', () => {
    const payload = {
      changes: [{ name: 'minimal', status: 'in-progress' }],
      root: { path: '/repo/openspec' },
    }
    const state = discoverWorktreeOpenSpec('/repo', {
      runner: runnerReturning({ ok: true, exitCode: 0, stdout: JSON.stringify(payload) }),
    })
    expect(state.changes).toEqual([{ name: 'minimal', status: 'in-progress' }])
  })

  test('runner receives the worktree cwd and configured timeout', () => {
    const seen: { value?: { cwd: string; timeoutMs: number } } = {}
    discoverWorktreeOpenSpec('/repo-wt', {
      runner: (options) => {
        seen.value = options
        return { ok: true, exitCode: 0, stdout: '{"changes":[]}', stderr: '' }
      },
      timeoutMs: 1234,
    })
    expect(seen.value).toEqual({ cwd: '/repo-wt', timeoutMs: 1234 })
  })
})
