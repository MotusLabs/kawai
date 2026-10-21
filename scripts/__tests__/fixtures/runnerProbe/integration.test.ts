import { test } from 'bun:test'
import fs from 'node:fs'

// F5 fixture: its BASENAME classifies it as a real-tmux (serial) batch, but
// it runs no tmux — it only marks that the serial batch started. The outer
// probe (scripts/__tests__/runnerRoots.test.ts) asserts this file never runs
// after a handled signal.
test('marks that the serial batch started', () => {
  const out = process.env.SERIAL_BATCH_PID_FILE
  if (out) fs.writeFileSync(out, String(process.pid))
})
