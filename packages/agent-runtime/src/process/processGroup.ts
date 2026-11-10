// POSIX process-group probes and signals for owned agent processes (design
// §3, task 2.3). An owned generation runs as the leader of its own group, so
// helpers it starts (and that inherit its pipes) share the group id. Members
// that are zombies are dead: they cannot write, and in containers without a
// reaping init they may never disappear from the process table.

import { readdirSync, readFileSync } from 'node:fs'

/** Whether this host can own and probe process groups. */
export const GROUPS_SUPPORTED = process.platform !== 'win32'

/** Group members' pids with their state letter, from /proc (Linux). */
function procGroupMembers(pgid: number): Array<{ pid: number; state: string }> | null {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return null
  }
  const members: Array<{ pid: number; state: string }> = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // exited between readdir and read
    }
    // "pid (comm) state ppid pgrp ..." — comm may hold spaces and parens.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (Number(fields[2]) === pgid) members.push({ pid: Number(entry), state: fields[0] ?? '?' })
  }
  return members
}

/** Live (non-zombie) members of group `pgid`; zombies count as dead. */
export function liveGroupMembers(pgid: number): number[] {
  const members = procGroupMembers(pgid)
  if (members !== null) return members.filter((m) => m.state !== 'Z' && m.state !== 'X').map((m) => m.pid)
  // Without /proc, signal 0 to the group: success means some member exists
  // (zombies included — this fallback cannot tell them apart).
  try {
    process.kill(-pgid, 0)
    return [-pgid]
  } catch {
    return []
  }
}

/** Send `signal` to every member of group `pgid`; false when the group is empty. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}
