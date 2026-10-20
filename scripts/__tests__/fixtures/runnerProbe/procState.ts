import fs from 'node:fs'

// True when the pid is gone or is a zombie (state Z, the field after the
// closing paren of /proc/<pid>/stat): a killed process lingers as a zombie
// until reaped, and kill(pid, 0) still succeeds on one.
export function isProcDead(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().charAt(0) === 'Z'
  } catch {
    return true // ENOENT: gone
  }
}
