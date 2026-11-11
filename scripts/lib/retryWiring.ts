// retryWiring.ts - The unit runner's real retry effects for
// runBatchesAndPublish (check-time-optimization D2, task 3.3): how a failed
// real-tmux batch's rerun is planned and reported, and how a batch's failing
// tests are read. Kept apart from realTmuxRetries.ts, which src/ code imports:
// this module reaches the runner's own modules.

import path from 'node:path'
import { rerunBatch, type PlannedBatch } from '../planBatches'
import type { RetryWiring } from '../runPlan'
import { appendPlannedRerun, junitReportPath, readJUnitFailures } from './junitReports'

/** The runner's retry effects: a rerun writes its own report beside the
 * first attempt's — into the check's directory, appended to the planned
 * manifest before the rerun starts and replacing the first report in the
 * merge (task 3.3), or into the run root's private directory. Report
 * indexes continue after the planned batches', so names stay unique. */
export function retryWiring(options: {
  enabled: boolean
  junitReportDir: string | undefined
  privateReportDir: string
  firstIndex: number
}): RetryWiring {
  let index = options.firstIndex
  return {
    enabled: options.enabled,
    planRerun: (batch: PlannedBatch) => {
      if (batch.report !== undefined && options.junitReportDir !== undefined) {
        const reportPath = junitReportPath(options.junitReportDir, index++, 'real-tmux-rerun')
        appendPlannedRerun(options.junitReportDir, { report: path.basename(reportPath), replaces: batch.report })
        return rerunBatch(batch, reportPath, true)
      }
      if (batch.reportPath !== undefined) {
        return rerunBatch(batch, junitReportPath(options.privateReportDir, index++, 'real-tmux-rerun'), false)
      }
      return rerunBatch(batch, undefined, false)
    },
    failingTests: (batch: PlannedBatch) =>
      batch.reportPath === undefined ? [] : (readJUnitFailures(batch.reportPath) ?? []),
  }
}
