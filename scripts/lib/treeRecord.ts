// treeRecord.ts - The full-pass record of one committed tree (per-result-suite
// D4). `bun run check` keys its records by the working tree's tree id plus
// the Bun version, platform, and architecture (checkKey.ts); a commit whose
// tree is that id is the same content, so its record is found under the same
// key. Used by the pre-push hook and by the commit hook's message-only amend
// gate — both only read; writing stays checkRun's alone.

import { contentKeyFrom } from '../../src/server/checks/checkKey'
import { readRecord, type CheckRecord } from '../../src/server/checks/checkRecords'

/** The content key a full check of `treeId` records under, for this Bun. */
export function treeRecordKey(treeId: string): string {
  return contentKeyFrom({
    treeId,
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
  })
}

/** The full-pass record for `treeId` in `dir`, or null. Beyond readRecord's
 * own checks (shape, key field, TTL), every key input the record states must
 * match: a record whose file name fits but whose fields describe another
 * tree or runtime is no pass for this one. */
export function readTreeRecord(dir: string, treeId: string, now = Date.now()): CheckRecord | null {
  const record = readRecord(dir, treeRecordKey(treeId), now)
  if (record === null) return null
  if (record.treeId !== treeId) return null
  if (record.bun !== Bun.version || record.platform !== process.platform || record.arch !== process.arch) {
    return null
  }
  return record
}
