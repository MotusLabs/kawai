// Starts a helper in its own process group that inherits this process's
// stdout, prints the helper's pid, and exits at once (task 2.3).
// argv: <tick file> [ignore-term]
import { spawn } from 'node:child_process'
import { join } from 'node:path'
const helper = spawn(process.execPath, [join(import.meta.dir, 'helper.ts'), ...process.argv.slice(2)], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
process.stdout.write(`${JSON.stringify({ helper: helper.pid })}\n`)
helper.unref()
setTimeout(() => process.exit(0), 100)
