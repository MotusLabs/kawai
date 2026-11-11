// The fake `codex app-server` as a process (see fakeCodexServer.ts for its
// directives and environment): this process's own stdio, pid and exit.
// FAKE_CODEX_TERM=ignore ignores SIGTERM, so a stop's teardown lasts until
// its SIGKILL escalation (a slow teardown for ordering witnesses).
// FAKE_CODEX_EOF=ignore also outlives stdin's end (the server otherwise exits
// on it), so with both the process lives until that SIGKILL.
import { PassThrough } from 'node:stream'
import { serveFakeCodex } from './fakeCodexServer.js'

if (process.env.FAKE_CODEX_TERM === 'ignore') process.on('SIGTERM', () => {})
const input = process.env.FAKE_CODEX_EOF === 'ignore' ? process.stdin.pipe(new PassThrough(), { end: false }) : process.stdin
// Nothing else holds the event loop once stdin ends: keep it alive for the SIGKILL.
if (process.env.FAKE_CODEX_EOF === 'ignore') setInterval(() => {}, 1000)

serveFakeCodex({
  env: process.env,
  pid: process.pid,
  cwd: process.cwd(),
  input,
  write: (text) => void process.stdout.write(text),
  exit: (code) => process.exit(code),
  canSpawnChildren: true,
})
