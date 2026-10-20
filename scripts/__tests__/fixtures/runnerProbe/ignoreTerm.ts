// Ignores SIGTERM so a reaper must escalate to SIGKILL (mutant m5's target).
// Writes READY_FILE once the handler is installed so the test never signals
// a runtime that has not started yet.
import fs from 'node:fs'

process.on('SIGTERM', () => {})
if (process.env.READY_FILE) fs.writeFileSync(process.env.READY_FILE, 'ready')
setInterval(() => {}, 1_000_000)
