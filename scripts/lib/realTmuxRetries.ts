// realTmuxRetries.ts - The real-tmux retries a full check's record names
// (check-time-optimization D3). The runner writes them beside the JUnit
// reports in the check's report directory after a passing run; the merge
// reads only `*.junit.xml`, so this file never enters the test list.
// The check pipeline copies them into the record. The runner's retry effects are in
// retryWiring.ts.

import fs from 'node:fs'
import path from 'node:path'
import { parseRetries, type RecordRetry } from '../../src/server/checks/checkRecords'

export const RETRIES_FILE_NAME = 'real-tmux-retries.json'

export function writeRetriesRecord(dir: string, retries: RecordRetry[]): void {
  fs.writeFileSync(path.join(dir, RETRIES_FILE_NAME), `${JSON.stringify(retries)}\n`)
}

/** The runner's retries; empty when it wrote none, null when malformed. */
export function readRetriesRecord(dir: string): RecordRetry[] | null {
  let text: string
  try {
    text = fs.readFileSync(path.join(dir, RETRIES_FILE_NAME), 'utf8')
  } catch {
    return []
  }
  try {
    return parseRetries(JSON.parse(text))
  } catch {
    return null
  }
}
