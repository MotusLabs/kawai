// Appends to a tick file and writes to the inherited stdout every 10 ms.
// argv: <tick file> [ignore-term]
import { appendFileSync } from 'node:fs'
const [file, mode] = process.argv.slice(2)
if (mode === 'ignore-term') process.on('SIGTERM', () => {})
process.stdout.on('error', () => {})
setInterval(() => {
  appendFileSync(file!, 'x')
  process.stdout.write('tick\n')
}, 10)
