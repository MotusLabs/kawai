// The plan workspace's wire messages (plan-workspace tasks 1.3, design D1,
// D4, D6), unioned into ServerMessage and ClientMessage in `types.ts`. Like
// every team view, each message names the team's directory (`teamPath`),
// resolved by the shared team-scope resolver; replies echo it beside
// `teamId`. The snapshot is authoritative and re-sent whole after every
// committed workspace write of the team — never on a replay or a refusal.
// The keyed commands carry both a `requestId` (correlation, echoed in the
// reply) and a `commandId` (the ledger key), so a resend replays instead of
// repeating. `team-plan-workspace-close` only ends the subscription.
import type {
  PlanWorkspaceRole, WorkspaceArtifactsView, WorkspaceBindingView, WorkspaceChecklist,
  WorkspaceChecklistUnavailable, WorkspaceDocumentView, WorkspaceRefView, WorkspaceSnapshot,
  WorkspaceVersionSelector,
} from './planWorkspace'

export type PlanWorkspaceServerMessage =
  | {
      type: 'team-plan-workspace-snapshot'
      teamPath: string
      teamId: string
      planId: string
      workspace: WorkspaceSnapshot
    }
  // The team's role bindings (Q1, Lead-authorized): one push per subscribed
  // team, on open/reconnect and after every committed binding write — never
  // on a refusal. The no-plan empty state binds through this alone.
  | {
      type: 'team-plan-workspace-bindings'
      teamPath: string
      teamId: string
      bindings: WorkspaceBindingView[]
    }
  // One change's checklist projection (2.4): the snapshot, or the explicit
  // unavailable state — never a silent empty projection. Re-pushed on
  // invalidation (a watcher event or the reconciliation pass).
  | {
      type: 'team-plan-workspace-checklist'
      teamPath: string
      planId: string
      changeName: string
      checklist: WorkspaceChecklist | null
      unavailable: WorkspaceChecklistUnavailable | null
    }
  // One document's provenance view (2.4): hash, availability, staleness and
  // the execution pin's match, with last-valid markdown text held when the
  // source went missing. Images never ride WS — the asset route serves bytes.
  | {
      type: 'team-plan-workspace-document'
      teamPath: string
      planId: string
      worktreeId: string
      relativePath: string
      view: WorkspaceDocumentView
    }
  // One change's canonical artifact enumeration (5.3): lazy descriptors in
  // the source worktree's address space (S2), or the named refusal. The
  // descriptors' pairs are exactly what `team-plan-workspace-document-open`
  // accepts; per-document metadata comes only from that open.
  | {
      type: 'team-plan-workspace-artifacts'
      teamPath: string
      planId: string
      changeName: string
      view: WorkspaceArtifactsView
    }
  // Result of a keyed workspace command: what a commit recorded — the bind's
  // `binding`, the reference a ref-add created, the id a ref-remove took —
  // with `replayed` when the command id already stood; `error` on refusal,
  // with `field` naming the offending field when one is at fault.
  | {
      type: 'team-plan-workspace-result'
      teamPath: string
      requestId: string
      binding?: { role: PlanWorkspaceRole; sessionId: string; version: number }
      ref?: WorkspaceRefView
      removedRefId?: string
      replayed?: boolean
      error?: string
      field?: string
    }

export type PlanWorkspaceClientMessage =
  | {
      type: 'team-plan-workspace-open'
      teamPath: string
      planId: string
      version?: WorkspaceVersionSelector
      /** Absent: the latest execution when one exists (design D2). */
      execution?: { executionId: string }
    }
  | { type: 'team-plan-workspace-close'; teamPath: string; planId: string }
  // The team-scoped bindings subscription (Q1): lazy — opened only while a
  // conversation panel is mounted; starts no agent; an unknown team refuses.
  | { type: 'team-plan-workspace-bindings-open'; teamPath: string }
  | { type: 'team-plan-workspace-bindings-close'; teamPath: string }
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
  | {
      type: 'team-plan-workspace-ref-add'
      teamPath: string
      requestId: string
      commandId: string
      planId: string
      label: string
      kind: 'local' | 'external'
      changeName?: string
      worktreeId?: string
      relativePath?: string
      url?: string
    }
  | { type: 'team-plan-workspace-ref-remove'; teamPath: string; requestId: string; commandId: string; refId: string }
  // Document subscriptions (2.4): one change's checklist, or one document of
  // a listed worktree. Every open answers an authoritative first snapshot
  // (checklist/view, or the explicit unavailable state); a close only ends
  // the subscription. The worktree is matched lexically against the team's
  // listed roots — no request-time filesystem resolution (B8.3).
  | { type: 'team-plan-workspace-checklist-open'; teamPath: string; planId: string; changeName: string }
  | { type: 'team-plan-workspace-checklist-close'; teamPath: string; planId: string; changeName: string }
  | {
      type: 'team-plan-workspace-document-open'
      teamPath: string
      planId: string
      worktreeId: string
      relativePath: string
      /** Absent: the plan's latest execution (design D2). */
      executionId?: string
    }
  | {
      type: 'team-plan-workspace-document-close'
      teamPath: string
      planId: string
      worktreeId: string
      relativePath: string
    }
  // One change's canonical artifact enumeration (5.3): the open answers an
  // authoritative first push; the close only ends the subscription. The
  // change name is shape-checked before any resolver or listing call.
  | { type: 'team-plan-workspace-artifacts-open'; teamPath: string; planId: string; changeName: string }
  | { type: 'team-plan-workspace-artifacts-close'; teamPath: string; planId: string; changeName: string }
