// Process report tools on the per-session `kawai-team` MCP server
// (team-process-metrics D6): submit (rights from the caller's current group
// file, re-read at each call), list and get (any team member), and link (a
// reporting agent's link of an accepted, unlinked proposal). Identity and
// team are bound to the calling session; no argument sets the author, team,
// window period, or snapshot. There is deliberately no tool that decides,
// applies, withdraws, relinks, or unlinks a proposal — those are the human's.
import { z } from 'zod'
import type { ProcessProposal, ProcessReport } from '../../shared/processReports'
import type { ReportCaller, ReportList, ProcessReportService } from './reportService'

export const REPORT_TOOL_NAMES = ['process_report_submit', 'process_reports_list', 'process_report_get', 'process_proposal_link'] as const

/** Tools that must never exist: deciding, applying, and undoing links are human-only. */
export const REPORT_FORBIDDEN_TOOL_NAMES = [
  'process_proposal_decide', 'process_proposal_accept', 'process_proposal_reject', 'process_proposal_apply',
  'process_proposal_withdraw', 'process_proposal_relink', 'process_proposal_unlink', 'process_report_delete',
] as const

const proposal = z.object({
  kind: z.string(),
  target_kind: z.string(),
  target: z.string(),
  edit: z.string(),
  rationale: z.string(),
  expected: z.array(z.object({ metric: z.string(), direction: z.string() })),
  revert_to_hash: z.string().nullable().optional(),
})

export const reportSchemas = {
  process_report_submit: z.object({ window: z.string(), summary: z.string(), proposals: z.array(proposal).optional() }),
  process_reports_list: z.object({ limit: z.number().int().positive().max(50).optional() }),
  process_report_get: z.object({ report_id: z.string() }),
  process_proposal_link: z.object({ proposal_id: z.string(), change_start_id: z.string() }),
}

export const reportDescriptions: Record<(typeof REPORT_TOOL_NAMES)[number], string> = {
  process_report_submit: 'Submit a process report (only if your group sets canReportProcess: true) for window 1d, 3d, or 7d with a summary and proposals. Kawai computes and freezes the metrics snapshot and period itself. Window roles: 1d carries no proposals, 3d only reverts, 7d changes and reverts. Each proposal: kind change|revert, target_kind group|memory, target (group id or shared memory file name), edit, rationale, expected [{metric, direction up|down}]; a revert names revert_to_hash, a hash recorded earlier for that target. Any refusal writes nothing. Proposals are decided only by the human.',
  process_reports_list: 'List your team\'s process reports newest first (default 10) with their frozen snapshots, proposals and their state (decision, link, outcome, link candidates), and the latest report per window with its age in hours.',
  process_report_get: 'Read one process report of your team with its frozen snapshot and proposals.',
  process_proposal_link: 'Link an accepted proposal that has no link yet to the version change that implemented it (only if your group sets canReportProcess: true). change_start_id must be one of the proposal\'s candidates: a version change of its target after the decision whose hash differs from the hash at decision (a change) or equals revert_to_hash (a revert). Only the human replaces or removes a link.',
}

export interface ReportToolDeps {
  /** The calling session as its current files define it; null outside any team. */
  caller: (sessionId: string) => Promise<ReportCaller | null>
  service: ProcessReportService
}

async function callerOf(deps: ReportToolDeps, sessionId: string): Promise<ReportCaller> {
  const caller = await deps.caller(sessionId)
  if (!caller) throw new Error('This session belongs to no team yet, so it has no process reports.')
  return caller
}

export function reportHandlers(deps: ReportToolDeps, sessionId: string) {
  return {
    process_report_submit: async (input: unknown): Promise<ProcessReport> => {
      const parsed = reportSchemas.process_report_submit.parse(input)
      return deps.service.submit(await callerOf(deps, sessionId), parsed)
    },
    process_reports_list: async (input: unknown): Promise<ReportList> => {
      const { limit } = reportSchemas.process_reports_list.parse(input)
      return deps.service.list((await callerOf(deps, sessionId)).teamId, limit ?? 10)
    },
    process_report_get: async (input: unknown): Promise<ProcessReport> => {
      const { report_id } = reportSchemas.process_report_get.parse(input)
      const report = deps.service.report((await callerOf(deps, sessionId)).teamId, report_id)
      if (!report) throw new Error(`Unknown report: ${report_id}`)
      return report
    },
    process_proposal_link: async (input: unknown): Promise<ProcessProposal> => {
      const { proposal_id, change_start_id } = reportSchemas.process_proposal_link.parse(input)
      return deps.service.linkByAgent(await callerOf(deps, sessionId), proposal_id, change_start_id)
    },
  }
}
