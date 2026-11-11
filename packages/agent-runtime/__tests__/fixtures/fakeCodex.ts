// The fake `codex app-server` as a process (see fakeCodexServer.ts for its
// directives and environment): this process's own stdio, pid and exit.
// FAKE_CODEX_TERM=ignore ignores SIGTERM, so a stop's teardown lasts until
// its SIGKILL escalation (a slow teardown for ordering witnesses).
import { serveFakeCodex } from './fakeCodexServer.js'

if (process.env.FAKE_CODEX_TERM === 'ignore') process.on('SIGTERM', () => {})

serveFakeCodex({
  env: process.env,
  pid: process.pid,
  cwd: process.cwd(),
  input: process.stdin,
  write: (text) => void process.stdout.write(text),
  exit: (code) => process.exit(code),
  canSpawnChildren: true,
})
