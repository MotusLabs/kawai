// Per-file temporary directories for the runner-provided variables (design
// D3, checkpoint-1 decision D-a): scripts/test-runner.ts passes this preload
// to every `bun test` child with --preload, and it runs before each test
// file's code. It creates a fresh directory beneath the parent runner's run
// root and points the four variables at it, so parallel files — and
// successive files on one reused worker — never share runner-provided paths.
// The preload sets only these four variables; everything else passes through
// unchanged. A bare `bun test` (no runner) has no KAWAI_TEST_RUN_ROOT and
// keeps the old shared-process mode.
import fs from 'node:fs'
import path from 'node:path'

const runRoot = process.env.KAWAI_TEST_RUN_ROOT

if (runRoot) {
  const fileRoot = fs.mkdtempSync(path.join(runRoot, 'file-'))
  const claudeDir = path.join(fileRoot, 'claude')
  const codexDir = path.join(fileRoot, 'codex')
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  process.env.CODEX_HOME = codexDir
  process.env.LOG_FILE = path.join(fileRoot, 'agentboard.log')
  process.env.AGENTBOARD_DB_PATH = path.join(fileRoot, 'agentboard.db')
}
