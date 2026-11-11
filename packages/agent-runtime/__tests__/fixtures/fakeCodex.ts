// The fake `codex app-server` as a process (see fakeCodexServer.ts for its
// directives and environment): this process's own stdio, pid and exit.
import { serveFakeCodex } from './fakeCodexServer.js'

serveFakeCodex({
  env: process.env,
  pid: process.pid,
  cwd: process.cwd(),
  input: process.stdin,
  write: (text) => void process.stdout.write(text),
  exit: (code) => process.exit(code),
  canSpawnChildren: true,
})
