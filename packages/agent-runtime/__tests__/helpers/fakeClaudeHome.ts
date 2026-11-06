// @reads: packages/agent-runtime/__tests__/fixtures/fakeClaude.ts
// A disposable launch for the fake Claude CLI: an isolated root with home,
// cache and temp directories, and a bin directory holding a `claude` wrapper
// that runs the fake under this Bun with its protocol on the real stdout
// (fd 3) and fd 1 discarded. The child's environment is exactly what the
// test passes plus PATH and the frame log; nothing is inherited.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchConfiguration } from '../../src/options.js'

const FAKE = join(import.meta.dir, '..', 'fixtures', 'fakeClaude.ts')

export interface FakeClaudeHome {
  root: string
  log: string
  launch(extraEnv?: Record<string, string>): LaunchConfiguration
  /** Frames the fake received on stdin, parsed. */
  received(): Array<Record<string, unknown>>
}

export function fakeClaudeHome(): FakeClaudeHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-runtime-claude-')))
  const bin = join(root, 'bin')
  for (const dir of [bin, join(root, 'home'), join(root, 'cache'), join(root, 'tmp'), join(root, 'work')]) mkdirSync(dir)
  const wrapper = join(bin, 'claude')
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@" 3>&1 1>/dev/null\n`)
  chmodSync(wrapper, 0o755)
  const log = join(root, 'frames.jsonl')
  return {
    root,
    log,
    launch: (extraEnv = {}) => ({
      cwd: join(root, 'work'),
      childEnv: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, 'home'), FAKE_CLAUDE_LOG: log, ...extraEnv },
      homeDir: join(root, 'home'),
      cacheDir: join(root, 'cache'),
      tempDir: join(root, 'tmp'),
    }),
    received: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
  }
}
