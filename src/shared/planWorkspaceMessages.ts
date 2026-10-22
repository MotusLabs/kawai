// The plan workspace's wire messages (plan-workspace tasks 1.3, design D1,
// D6), unioned into ServerMessage and ClientMessage in `types.ts`. Like every
// team view, each message names the team's directory (`teamPath`), resolved
// by the shared team-scope resolver; replies echo it beside `teamId`. The
// snapshot is authoritative and re-sent whole after every committed
// workspace write of the team — never on a replay or a refusal. The keyed
// commands carry both a `requestId` (correlation, echoed in the reply) and a
// `commandId` (the ledger key), so a resend replays instead of repeating.
// `team-plan-workspace-close` only ends the subscription.
import type {
  PlanWorkspaceRole, WorkspaceSnapshot, WorkspaceVersionSelector,
} from './planWorkspace'

export type PlanWorkspaceServerMessage =
  | {
      type: 'team-plan-workspace-snapshot'
      teamPath: string
      teamId: string
      planId: string
      workspace: WorkspaceSnapshot
    }
  // Result of a keyed workspace command: the binding a bind recorded
  // (`replayed` when the command id already stood); `error` on refusal, with
  // `field` naming the offending field when one is at fault.
  | {
      type: 'team-plan-workspace-result'
      teamPath: string
      requestId: string
      binding?: { role: PlanWorkspaceRole; sessionId: string; version: number }
      replayed?: boolean
      error?: string
      field?: string
    }

export type PlanWorkspaceClientMessage =
  | { type: 'team-plan-workspace-open'; teamPath: string; planId: string; version?: WorkspaceVersionSelector }
  | { type: 'team-plan-workspace-close'; teamPath: string; planId: string }
  | {
      type: 'team-plan-workspace-bind'
      teamPath: string
      requestId: string
      commandId: string
      role: PlanWorkspaceRole
      sessionId: string
      /** The CAS token the binder saw; null = the role must be unbound. */
      expectedVersion: number | null
    }
