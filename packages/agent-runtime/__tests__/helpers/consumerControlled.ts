// @reads: packages/agent-runtime/__tests__/fixtures/fakeClaude.ts, packages/agent-runtime/__tests__/fixtures/fakeCodex.ts, packages/agent-runtime/__tests__/fixtures/fakeCodexServer.ts
// Copy accepted protocol fixtures into the independent consumer. The wrapper
// records its owned PID before exec; no repository module is loaded at run time.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchConfiguration } from '../../src/options.js'

export function controlledLaunch(project: string, runtime: 'claude' | 'codex', bun: string): LaunchConfiguration {
  const root = join(project, runtime)
  for (const name of ['', 'work', 'home', 'cache', 'temp', 'bin']) mkdirSync(join(root, name), { recursive: true })
  const source = join(import.meta.dir, '../fixtures')
  const fake = join(root, `consumer${runtime}.ts`)
  copyFileSync(join(source, runtime === 'claude' ? 'fakeClaude.ts' : 'fakeCodex.ts'), fake)
  if (runtime === 'codex') copyFileSync(join(source, 'fakeCodexServer.ts'), join(root, 'fakeCodexServer.ts'))
  const executablePath = join(root, 'bin', runtime)
  const pids = join(root, 'pids')
  writeFileSync(executablePath, `#!/bin/sh\necho $$ >> '${pids}'\nexec '${bun}' '${fake}' "$@"${runtime === 'claude' ? ' 3>&1 1>/dev/null' : ''}\n`)
  chmodSync(executablePath, 0o755)
  return {
    cwd: join(root, 'work'), executablePath, homeDir: join(root, 'home'), cacheDir: join(root, 'cache'), tempDir: join(root, 'temp'),
    childEnv: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), CODEX_HOME: join(root, 'home'), FAKE_CLAUDE_SESSIONS: '1', FAKE_CLAUDE_LOG: join(root, 'frames.jsonl') },
  }
}

export function recordedPids(project: string, runtime: string): number[] {
  return readFileSync(join(project, runtime, 'pids'), 'utf8').trim().split('\n').map(Number)
}
