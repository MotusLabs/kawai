// One process generation as an owned job (design §3, task 2.2). A driver
// consumes the generation's stdout (the SDK iterator or the Codex JSON-RPC
// reader) inside this job, and the job completes with the leader's ACTUAL
// exit — never at stream EOF. A process can close its stdout and keep
// running; treating EOF as death would report an exit, and allow a respawn,
// while the old process still lives.

import type { Readable } from 'node:stream'
import type { OwnedJobs } from './jobs.js'
import type { LeaderExit, OwnedProcess } from '../process/ownedProcess.js'

export function runGeneration(
  jobs: OwnedJobs,
  owned: OwnedProcess,
  consume: (stdout: Readable) => Promise<void>,
): Promise<LeaderExit> {
  return jobs.run(`generation:${owned.generation}`, async () => {
    await consume(owned.stdout)
    return owned.leaderExit
  })
}
