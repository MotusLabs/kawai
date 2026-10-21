import fs from 'node:fs'

// Records the four runner-provided paths so the outer probe test
// (scripts/__tests__/runnerRoots.test.ts) can assert that concurrent and
// successive files receive distinct roots, and that every root is removed
// after the run. Read at module load — after the preload ran, before any
// test body. Writes only when KAWAI_PROBE_OUT is set, i.e. when driven by
// that outer test.
export function recordRoots(name: string): void {
  const out = process.env.KAWAI_PROBE_OUT
  if (out === undefined) return
  const snapshot = {
    name,
    pid: process.pid,
    db: process.env.AGENTBOARD_DB_PATH,
    log: process.env.LOG_FILE,
    claude: process.env.CLAUDE_CONFIG_DIR,
    codex: process.env.CODEX_HOME,
  }
  fs.appendFileSync(out, `${JSON.stringify(snapshot)}\n`)
}
