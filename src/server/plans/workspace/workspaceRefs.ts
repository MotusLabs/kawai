// The plan workspace's document references (plan-workspace 1.2, design D4):
// supporting metadata — a labelled local path inside a listed worktree or an
// external https link — attached to a plan or one of its changes. Add and
// remove are keyed commands sharing the bind ledger (commandLedger.ts); a
// replay never re-validates, because validation is at insert time only: a
// change name valid when inserted stays removable after every revision that
// named it is gone. Removing never deletes a file and never touches plan
// approval. The store reads and writes only: team scoping and the resolver
// facts belong to the connection that resolves the team.
import type { Database } from 'bun:sqlite'
import type { WorkspaceRefPayload, WorkspaceRefRemovePayload, WorkspaceRefView } from '../../../shared/planWorkspace'
import { isRelativeWorkspacePath } from '../../../shared/planWorkspace'
import { ledgerLookup, ledgerRecord } from './commandLedger'

/** The plan and worktree facts a new reference is validated against, resolved by the connection. */
export interface WorkspaceRefResolvers {
  /** Whether the plan exists in this team (another team's plan reads as not found). */
  planInTeam: (planId: string) => boolean
  /** The change names valid at insert: the union over the approved revision, every in-review revision and every draft. */
  changeNames: (planId: string) => ReadonlySet<string>
  /** The task-worktree check: whether the id is a listed worktree root of the team. */
  worktreeTarget: (worktreeId: string) => Promise<boolean>
}

type RefRefusal =
  | { ok: false; reason: 'invalid' | 'payload' | 'not-found'; message: string; field?: string }

export type WorkspaceRefAddOutcome =
  | { ok: true; replayed: boolean; ref: WorkspaceRefView }
  | RefRefusal

export type WorkspaceRefRemoveOutcome =
  | { ok: true; replayed: boolean; removedRefId: string; planId: string }
  | RefRefusal

/** The stored row a view is read from. */
type Row = Record<string, unknown>

const LABEL_LIMIT = 200

/** Shape-check a ref-add payload without touching the database; the fields the ledger records. */
function cleanRefPayload(raw: WorkspaceRefPayload): { ok: true; clean: Required<Pick<WorkspaceRefPayload, 'planId' | 'label' | 'kind'>> & Partial<WorkspaceRefPayload> } | { ok: false; message: string; field: string } {
  const planId = typeof raw.planId === 'string' ? raw.planId.trim() : ''
  if (planId === '') return { ok: false, message: 'A reference needs the plan it supports.', field: 'planId' }
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (label === '' || label.length > LABEL_LIMIT) return { ok: false, message: `A reference needs a non-empty label of at most ${LABEL_LIMIT} characters.`, field: 'label' }
  if (raw.kind !== 'local' && raw.kind !== 'external') return { ok: false, message: 'A reference is either local (a worktree path) or external (an https link).', field: 'kind' }
  const changeName = typeof raw.changeName === 'string' ? raw.changeName.trim() : ''
  if (raw.changeName !== undefined && changeName === '') return { ok: false, message: 'A change name, when given, cannot be empty.', field: 'changeName' }
  if (raw.kind === 'local') {
    const worktreeId = typeof raw.worktreeId === 'string' ? raw.worktreeId.trim() : ''
    if (worktreeId === '') return { ok: false, message: 'A local reference needs the worktree root it resolves in.', field: 'worktreeId' }
    const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath : ''
    if (!isRelativeWorkspacePath(relativePath)) return { ok: false, message: 'A local reference needs a relative, normalized path (no absolute path, "..", NUL, or network path).', field: 'relativePath' }
    if (raw.url !== undefined) return { ok: false, message: 'A local reference carries a worktree path, not a URL.', field: 'url' }
    return { ok: true, clean: { planId, label, kind: 'local', worktreeId, relativePath, ...(changeName !== '' ? { changeName } : {}) } }
  }
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  let https = false
  try { https = url !== '' && new URL(url).protocol === 'https:' } catch { https = false }
  if (!https) return { ok: false, message: 'An external reference needs an https URL (the server never fetches it).', field: 'url' }
  if (raw.worktreeId !== undefined || raw.relativePath !== undefined) return { ok: false, message: 'An external reference carries a URL, not a worktree path.', field: 'worktreeId' }
  return { ok: true, clean: { planId, label, kind: 'external', url, ...(changeName !== '' ? { changeName } : {}) } }
}

export class PlanWorkspaceRefs {
  constructor(private readonly db: Database) {}

  /**
   * One keyed ref-add: replay first (no re-validation), then the insert-time
   * checks against the resolved facts, then the row and the ledger entry in
   * one transaction. The worktree check is awaited before the transaction —
   * bun:sqlite transactions are synchronous — and the ledger is re-read
   * inside it, so a racing writer still replays.
   */
  async add(teamId: string, commandId: string, raw: WorkspaceRefPayload, resolvers: WorkspaceRefResolvers, now = new Date().toISOString()): Promise<WorkspaceRefAddOutcome> {
    const id = typeof commandId === 'string' ? commandId.trim() : ''
    if (id === '') return { ok: false, reason: 'invalid', field: 'commandId', message: 'A reference command needs a stable command id so a resend replays instead of repeating.' }
    const shape = cleanRefPayload(raw)
    if (!shape.ok) return { ok: false, reason: 'invalid', field: shape.field, message: shape.message }
    const clean = shape.clean
    const pre = ledgerLookup<WorkspaceRefView>(this.db, teamId, id, 'ref-add', clean as Record<string, unknown>)
    if (pre) return this.toOutcome(pre)
    const worktreeOk = clean.kind === 'local' ? await resolvers.worktreeTarget(clean.worktreeId!) : true
    return this.db.transaction((): WorkspaceRefAddOutcome => {
      const again = ledgerLookup<WorkspaceRefView>(this.db, teamId, id, 'ref-add', clean as Record<string, unknown>)
      if (again) return this.toOutcome(again)
      if (!resolvers.planInTeam(clean.planId)) {
        return { ok: false, reason: 'not-found', field: 'planId', message: `Plan not found in this team: ${clean.planId}` }
      }
      if (clean.changeName !== undefined && !resolvers.changeNames(clean.planId).has(clean.changeName)) {
        return { ok: false, reason: 'invalid', field: 'changeName', message: `Change "${clean.changeName}" is not a change of plan ${clean.planId} (its approved, in-review, or draft content).` }
      }
      if (clean.kind === 'local' && !worktreeOk) {
        return { ok: false, reason: 'invalid', field: 'worktreeId', message: `${clean.worktreeId} is not a worktree of this team's repository` }
      }
      const refId = `ref-${crypto.randomUUID()}`
      this.db.prepare('INSERT INTO plan_document_refs (id, team_id, plan_id, change_name, label, kind, worktree_id, relative_path, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(refId, teamId, clean.planId, clean.changeName ?? null, clean.label, clean.kind, clean.worktreeId ?? null, clean.relativePath ?? null, clean.url ?? null, now)
      const ref = this.toRef(this.db.prepare('SELECT * FROM plan_document_refs WHERE id = ?').get(refId) as Row)
      ledgerRecord(this.db, teamId, id, 'ref-add', clean as Record<string, unknown>, ref, now)
      return { ok: true, replayed: false, ref }
    })()
  }

  /**
   * One keyed ref-remove: `WHERE team_id = ? AND id = ?`, one not-found
   * message for a gone or foreign reference, nothing written on any
   * refusal. The removed row's plan id rides the outcome, so the re-push
   * names the plan the reference belonged to.
   */
  remove(teamId: string, commandId: string, raw: WorkspaceRefRemovePayload, now = new Date().toISOString()): WorkspaceRefRemoveOutcome {
    const id = typeof commandId === 'string' ? commandId.trim() : ''
    if (id === '') return { ok: false, reason: 'invalid', field: 'commandId', message: 'A reference command needs a stable command id so a resend replays instead of repeating.' }
    const refId = typeof raw.refId === 'string' ? raw.refId.trim() : ''
    if (refId === '') return { ok: false, reason: 'invalid', field: 'refId', message: 'A removal needs the reference id to remove.' }
    const clean: WorkspaceRefRemovePayload = { refId }
    return this.db.transaction((): WorkspaceRefRemoveOutcome => {
      const ledger = ledgerLookup<{ removedRefId: string; planId: string }>(this.db, teamId, id, 'ref-remove', clean as unknown as Record<string, unknown>)
      if (ledger) {
        return ledger.ok ? { ok: true, replayed: true, removedRefId: ledger.value.removedRefId, planId: ledger.value.planId } : { ...ledger }
      }
      const row = this.db.prepare('SELECT * FROM plan_document_refs WHERE team_id = ? AND id = ?').get(teamId, refId) as Row | null
      if (!row) return { ok: false, reason: 'not-found', message: `Reference not found in this team: ${refId}` }
      this.db.prepare('DELETE FROM plan_document_refs WHERE team_id = ? AND id = ?').run(teamId, refId)
      const recorded = { removedRefId: refId, planId: String(row.plan_id) }
      ledgerRecord(this.db, teamId, id, 'ref-remove', clean as unknown as Record<string, unknown>, recorded, now)
      return { ok: true, replayed: false, ...recorded }
    })()
  }

  /** The plan's references, oldest first (the snapshot's order). */
  refsOf(teamId: string, planId: string): WorkspaceRefView[] {
    const rows = this.db.prepare('SELECT * FROM plan_document_refs WHERE team_id = ? AND plan_id = ? ORDER BY created_at, id').all(teamId, planId) as Row[]
    return rows.map(row => this.toRef(row))
  }

  private toOutcome(ledger: { ok: true; replayed: boolean; value: WorkspaceRefView } | { ok: false; reason: 'payload'; field: string; message: string }): WorkspaceRefAddOutcome {
    return ledger.ok ? { ok: true, replayed: ledger.replayed, ref: ledger.value } : { ...ledger }
  }

  private toRef(row: Row): WorkspaceRefView {
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      changeName: row.change_name === null ? null : String(row.change_name),
      label: String(row.label),
      kind: row.kind === 'external' ? 'external' : 'local',
      worktreeId: row.worktree_id === null ? null : String(row.worktree_id),
      relativePath: row.relative_path === null ? null : String(row.relative_path),
      url: row.url === null ? null : String(row.url),
      createdAt: String(row.created_at),
    }
  }
}
