// treeTestList.ts - The citation check's real test-list reader
// (independent-verification D7, task 4.3): resolves the commit tree's
// newest recorded full-check pass that carries a usable test list. PR C's
// seam promised the lookup; this module provides it from the records the
// check machinery wrote. Fail-closed like the store it reads: a missing,
// unreadable, or mismatched list falls through to the next older record,
// and a tree with no usable list reads as no list — every found citation
// then reads run-unknown, never fabricated data (K1).

import { recordsDir, recordsForTree } from '../checks/checkRecords'
import { readTestList, type TestListEntry } from '../checks/testLists'
import type { TestListLookup } from './resultChecks'

/** One lookup over the parsed entries: the executed file and the bare test
 * title decide; `skipped` and `todo` both answer skipped (D5), anything
 * else absent. The map is built once per list and answers every citation
 * of the check. */
export function lookupIn(entries: TestListEntry[]): TestListLookup {
  const statusByLocation = new Map(entries.map((entry) => [`${entry.file}\0${entry.name}`, entry.status]))
  return (file, title) => {
    const status = statusByLocation.get(`${file}\0${title}`)
    if (status === 'passed') return 'passed'
    if (status === 'skipped' || status === 'todo') return 'skipped'
    return 'absent'
  }
}

/** The newest record of `treeId` whose test list is usable — records are
 * newest first by their own `at` — as a citation lookup. Null when the
 * tree id is not a tree, the repository or its records directory cannot be
 * read, the tree has no record, or no record's list is usable (absent,
 * corrupt, unsorted, or a count that disagrees with its pointer: each is
 * skipped, never thrown, so one bad record cannot blind the citations of a
 * tree an older, intact record also covers). */
export function readTreeTestList(repoRoot: string, treeId: string): TestListLookup | null {
  if (!/^[0-9a-f]{40}$/.test(treeId)) return null
  let dir: string
  try {
    dir = recordsDir(repoRoot)
  } catch {
    return null
  }
  for (const record of recordsForTree(dir, treeId)) {
    const entries = readTestList(dir, record)
    if (entries !== null) return lookupIn(entries)
  }
  return null
}
