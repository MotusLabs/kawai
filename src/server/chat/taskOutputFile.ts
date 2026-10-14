// The output-tail file fallback (background tasks design D3): reading the
// last 8 KiB of a settled task's recorded output file after the SDK process
// that could answer `get_task_output` is gone. The path comes only from the
// task's own task_notification, persisted by the sidecar — a client never
// supplies one — and is accepted only when it is absolute, named
// `<taskId>.output`, and sits in a `tasks/` directory under the OS temp dir,
// where the CLI records task output (verified: /tmp/claude-<uid>/<project
// slug>/<sessionId>/tasks/<taskId>.output). Anything else reads as
// unavailable.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The tail cap: the CLI's own `get_task_output` returns at most this much. */
export const TASK_OUTPUT_TAIL_BYTES = 8 * 1024

/** Whether a recorded output-file path is safe to read for this task. */
export function isTaskOutputFile(file: string, taskId: string): boolean {
  if (!path.isAbsolute(file)) return false
  if (path.basename(file) !== `${taskId}.output`) return false
  const dir = path.dirname(file)
  if (path.basename(dir) !== 'tasks') return false
  const tmp = fs.realpathSync(os.tmpdir())
  const resolved = path.resolve(dir)
  return resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`)
}

export interface TaskOutputTail {
  output: string
  totalBytes: number
  truncated: boolean
}

/**
 * The last `maxBytes` of the file decoded as UTF-8. A code point split by
 * the window's leading edge is dropped (its continuation bytes decode to
 * U+FFFD otherwise). Null when the file cannot be read — the caller answers
 * `unavailable`, never an error.
 */
export function readTaskOutputTail(file: string, maxBytes = TASK_OUTPUT_TAIL_BYTES): TaskOutputTail | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = fs.fstatSync(fd)
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, size - length)
    let start = 0
    // Strip leading UTF-8 continuation bytes (0b10xxxxxx): the window cut a
    // code point in half.
    while (start < read && (buffer[start]! & 0b1100_0000) === 0b1000_0000) start += 1
    return {
      output: buffer.subarray(start, read).toString('utf8'),
      totalBytes: size,
      truncated: size > read,
    }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}
