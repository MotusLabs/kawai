// Writes a heartbeat line every 200 ms until killed (T1's liveness signal:
// after the runner's group kill the file must stop growing). argv: [outFile]
import fs from 'node:fs'

const out = process.argv[2]
const started = Date.now()
setInterval(() => {
  fs.appendFileSync(out, `${Date.now() - started}\n`)
}, 200)
