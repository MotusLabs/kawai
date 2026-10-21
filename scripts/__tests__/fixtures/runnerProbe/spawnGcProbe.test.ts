import { test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

// T1 fixture: spawns a heartbeat grandchild (standing in for the tmux, git,
// or spawned-server processes real tests start), records its pid and the run
// root, then sleeps long enough that the outer probe can signal the runner
// mid-run. The outer probe asserts the grandchild dies with the runner's
// child group.
test('spawns a heartbeat grandchild then sleeps', async () => {
  const ready = process.env.GC_READY_FILE
  const heartbeat = process.env.GC_HEARTBEAT_FILE
  if (ready && heartbeat) {
    const gc = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, 'gcHeartbeat.ts'), heartbeat],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    fs.writeFileSync(ready, JSON.stringify({ pid: gc.pid, runRoot: process.env.KAWAI_TEST_RUN_ROOT }))
  }
  await Bun.sleep(120_000)
}, 150_000)
