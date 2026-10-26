// Per-file temporary directories for the runner-provided variables (design
// D3, checkpoint-1 decision D-a): scripts/test-runner.ts passes this preload
// to every `bun test` child with --preload, and it runs before each test
// file's code. It creates a fresh directory beneath the parent runner's run
// root and points the five variables at it, so parallel files — and
// successive files on one reused worker — never share runner-provided paths.
// HOME joins them so nothing under the runner reads the real ~/.kawai,
// ~/.agentboard, or ~/.claude (a user-level routing rule there once broke
// clean-master runs). The preload sets only these five variables; everything
// else passes through unchanged. A bare `bun test` (no runner) has no
// KAWAI_TEST_RUN_ROOT and keeps the old shared-process mode.
import fs from 'node:fs'
import path from 'node:path'

const runRoot = process.env.KAWAI_TEST_RUN_ROOT

if (runRoot) {
  const fileRoot = fs.mkdtempSync(path.join(runRoot, 'file-'))
  const homeDir = path.join(fileRoot, 'home')
  const claudeDir = path.join(fileRoot, 'claude')
  const codexDir = path.join(fileRoot, 'codex')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true })
  process.env.HOME = homeDir
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  process.env.CODEX_HOME = codexDir
  process.env.LOG_FILE = path.join(fileRoot, 'agentboard.log')
  process.env.AGENTBOARD_DB_PATH = path.join(fileRoot, 'agentboard.db')
}
