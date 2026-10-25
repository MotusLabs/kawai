// envProbe.test.ts — preload probe fixture: a child `bun test` spawned by
// testPreload.test.ts runs this file with the real scripts/test-preload.ts
// preloaded, and it records the environment the preload gave this process.
// The runner never collects it: the unit globs do not recurse into fixtures/.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'

test('records the preload-provided environment', () => {
  const out = process.env.PRELOAD_PROBE_OUT
  expect(out).toBeTruthy()
  const snapshot = {
    home: process.env.HOME,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
    logFile: process.env.LOG_FILE,
    dbPath: process.env.AGENTBOARD_DB_PATH,
    runRoot: process.env.KAWAI_TEST_RUN_ROOT ?? null,
  }
  fs.mkdirSync(path.dirname(out!), { recursive: true })
  fs.writeFileSync(out!, JSON.stringify(snapshot))
})
