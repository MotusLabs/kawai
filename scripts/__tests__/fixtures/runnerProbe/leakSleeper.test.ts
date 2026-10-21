import { expect, test } from 'bun:test'
import fs from 'node:fs'

// T3 fixture: passes but leaves a long-lived process behind — the leftover
// class the runner's post-exit group kill exists for. The outer probe
// asserts the sleeper is dead after the runner exits 0.
test('passes but leaves a sleeper behind', () => {
  const out = process.env.SLEEPER_PID_FILE
  if (out) {
    const sleeper = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1e6)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    fs.writeFileSync(out, String(sleeper.pid))
  }
  expect(1).toBe(1)
})
