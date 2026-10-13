// Output-tail fallback scenarios (background tasks design D3): path
// validation (absolute, <taskId>.output, under a tasks/ dir in the OS temp
// dir), the 8 KiB cap with the truncated flag, UTF-8-safe windows, and
// missing files reading as null.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isTaskOutputFile, readTaskOutputTail, TASK_OUTPUT_TAIL_BYTES } from '../chat/taskOutputFile'

describe('taskOutputFile', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-output-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const taskFile = (taskId: string, name = `${taskId}.output`) =>
    path.join(dir, 'tasks', name)

  test('accepts only the recorded CLI layout for this task', () => {
    expect(isTaskOutputFile(taskFile('b1'), 'b1')).toBe(true)
    // Another task's file, a wrong name, a missing tasks/ dir.
    expect(isTaskOutputFile(taskFile('b1'), 'b2')).toBe(false)
    expect(isTaskOutputFile(path.join(dir, 'tasks', 'notes.txt'), 'b1')).toBe(false)
    expect(isTaskOutputFile(path.join(dir, 'other', 'b1.output'), 'b1')).toBe(false)
    // Relative paths and traversal never read.
    expect(isTaskOutputFile('tasks/b1.output', 'b1')).toBe(false)
    expect(isTaskOutputFile(path.join(dir, 'tasks', '..', '..', 'b1.output'), 'b1')).toBe(false)
    // Outside the OS temp dir (a plausible-looking absolute path).
    expect(isTaskOutputFile('/var/tmp/claude-1000/proj/sess/tasks/b1.output', 'b1')).toBe(
      os.tmpdir().startsWith('/var/tmp')
    )
  })

  test('reads the whole short file', () => {
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    fs.writeFileSync(taskFile('b1'), 'shell-a-done\n')
    expect(readTaskOutputTail(taskFile('b1'))).toEqual({
      output: 'shell-a-done\n',
      totalBytes: 13,
      truncated: false,
    })
  })

  test('caps the window at 8 KiB from the end and marks it truncated', () => {
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    const filler = 'x'.repeat(TASK_OUTPUT_TAIL_BYTES + 100)
    const file = taskFile('b1')
    fs.writeFileSync(file, `${filler}TAIL`)
    const tail = readTaskOutputTail(file)!
    expect(tail.output.endsWith('TAIL')).toBe(true)
    expect(tail.output.length).toBe(TASK_OUTPUT_TAIL_BYTES)
    expect(tail.totalBytes).toBe(filler.length + 4)
    expect(tail.truncated).toBe(true)
  })

  test('drops a code point the window cut in half', () => {
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    const euro = '€' // three UTF-8 bytes
    const file = taskFile('b1')
    fs.writeFileSync(file, `${'a'.repeat(TASK_OUTPUT_TAIL_BYTES - 1)}${euro}!`)
    const tail = readTaskOutputTail(file)!
    // The window starts inside the euro sign: its continuation bytes are
    // dropped, the ASCII '!' survives, and no U+FFFD replacement appears.
    expect(tail.output.endsWith('!')).toBe(true)
    expect(tail.output).not.toContain('�')
  })

  test('a missing file reads as null, never throws', () => {
    expect(readTaskOutputTail(path.join(dir, 'tasks', 'gone.output'))).toBeNull()
  })
})
