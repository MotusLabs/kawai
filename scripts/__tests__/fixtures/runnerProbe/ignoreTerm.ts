// Ignores SIGTERM so a reaper must escalate to SIGKILL (mutants m5 and m7).
// Writes READY_FILE once the handler is installed so the test never signals
// a runtime that has not started yet. With GC_HEARTBEAT_FILE and GC_PID_FILE
// set it also spawns a heartbeat grandchild, standing in for a process a
// test leaves behind (T2).
import fs from 'node:fs'
import path from 'node:path'

process.on('SIGTERM', () => {})
if (process.env.READY_FILE) fs.writeFileSync(process.env.READY_FILE, 'ready')
if (process.env.GC_HEARTBEAT_FILE && process.env.GC_PID_FILE) {
  const gc = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, 'gcHeartbeat.ts'), process.env.GC_HEARTBEAT_FILE],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  fs.writeFileSync(process.env.GC_PID_FILE, String(gc.pid))
}
setInterval(() => {}, 1_000_000)
