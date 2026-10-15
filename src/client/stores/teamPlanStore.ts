// Per-team Plans views (durable-plans 8.1, design D12): the team's plan
// list, the selected plan's detail, in-flight human commands, and the
// command ids of the approve/withdraw/finish/reopen dialogs. Server snapshots
// are authoritative and replace local state whole; closed views ignore late
// pushes, and a detail push for a plan that is no longer selected is
// dropped. A dialog mints its command id when it opens (`arm`) and keeps it
// while the payload it sends is unchanged, so a resend after a lost result
// replays on the server; a changed payload re-mints, and success retires the
// slot. A refusal marks the armed command refused: the same command against
// the same state would be refused again, so the dialog's Confirm stays off
// until the dialog is reopened, which arms a new command. `reconnected` drops every pending request, so a result lost with the
// connection never leaves the view busy.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'

export type PlanAction = 'approve' | 'withdraw' | 'finish' | 'reopen'

/** One dialog's command id and the payload it was last sent with (null = not sent yet). */
export interface ArmedPlanCommand {
  commandId: string
  payload: string | null
  /** The server refused it; only reopening the dialog (a new command) can try again. */
  refused?: boolean
}

export interface PlanView {
  open: boolean
  loading: boolean
  /** null until the first snapshot. */
  plans: PlanSummary[] | null
  selected: string | null
  detail: PlanDetail | null
  /** Commands awaiting their `team-plan-result`, by request id. */
  pending: Record<string, PlanAction>
  /** The last refusal's message and failing preconditions, until the next command or reopen. */
  error: string | null
  failures: Array<{ name: string; message: string }>
  /** Armed dialog command ids, by dialog slot (e.g. `approve:<plan>:<revision>`). */
  commands: Record<string, ArmedPlanCommand>
  /** Which slot each pending request was sent from. */
  commandRequests: Record<string, string>
}

export const closedPlanView = (): PlanView => ({
  open: false, loading: false, plans: null, selected: null, detail: null, pending: {}, error: null, failures: [], commands: {}, commandRequests: {},
})

interface PlanState {
  views: Record<string, PlanView>
  open: (teamKey: string, planId?: string) => void
  close: (teamKey: string) => void
  /** Move a view to the chat's new team key; a view already open under the new key wins. */
  rekey: (from: string, to: string) => void
  select: (teamKey: string, planId: string | null) => void
  /** A dialog opened: mint its command id (a reopened dialog is a new command). */
  arm: (teamKey: string, slot: string) => void
  /** The command id to send from `slot` with `payload`: the armed one unless the payload changed. */
  command: (teamKey: string, slot: string, payload: string, requestId: string) => string
  begin: (teamKey: string, requestId: string, action: PlanAction) => void
  /** The connection came back: results of pending requests are lost, so stop waiting for them. */
  reconnected: (teamKey: string) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-plans-snapshot' }>) => void
  applyDetail: (message: Extract<ServerMessage, { type: 'team-plan-detail' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-plan-result' }>) => void
}

const update = (state: PlanState, teamKey: string, patch: Partial<PlanView>) => {
  const view = state.views[teamKey]
  if (!view?.open) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

export const useTeamPlanStore = create<PlanState>(set => ({
  views: {},
  open: (teamKey, planId) => set(state => {
    const view = state.views[teamKey] ?? closedPlanView()
    return { views: { ...state.views, [teamKey]: {
      ...view, open: true, loading: view.plans === null, error: null, failures: [],
      ...(planId !== undefined ? { selected: planId, detail: view.detail?.plan.id === planId ? view.detail : null } : {}),
    } } }
  }),
  close: teamKey => set(state => {
    const views = { ...state.views }
    delete views[teamKey]
    return { views }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  select: (teamKey, planId) => set(state => update(state, teamKey, {
    selected: planId,
    detail: planId !== null && state.views[teamKey]?.detail?.plan.id === planId ? state.views[teamKey]!.detail : null,
    error: null, failures: [],
  })),
  arm: (teamKey, slot) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return update(state, teamKey, { commands: { ...view.commands, [slot]: { commandId: crypto.randomUUID(), payload: null } } })
  }),
  command: (teamKey, slot, payload, requestId) => {
    let commandId: string = crypto.randomUUID()
    set(state => {
      const view = state.views[teamKey]
      if (!view?.open) return state
      const armed = view.commands[slot]
      if (armed && (armed.payload === null || armed.payload === payload)) commandId = armed.commandId
      return update(state, teamKey, {
        commands: { ...view.commands, [slot]: { commandId, payload } },
        commandRequests: { ...view.commandRequests, [requestId]: slot },
      })
    })
    return commandId
  },
  begin: (teamKey, requestId, action) => set(state => update(state, teamKey, {
    pending: { ...state.views[teamKey]?.pending, [requestId]: action }, error: null, failures: [],
  })),
  reconnected: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open || Object.keys(view.pending).length === 0) return state
    return update(state, teamKey, { pending: {}, commandRequests: {} })
  }),
  applySnapshot: message => set(state => update(state, message.teamPath, { loading: false, plans: message.plans })),
  applyDetail: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open || view.selected !== message.detail.plan.id) return state
    return update(state, message.teamPath, { detail: message.detail })
  }),
  applyResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open || !(message.requestId in view.pending)) return state
    const pending = { ...view.pending }
    delete pending[message.requestId]
    const commandRequests = { ...view.commandRequests }
    const slot = commandRequests[message.requestId]
    delete commandRequests[message.requestId]
    if (message.error) {
      const armed = slot ? view.commands[slot] : undefined
      const commands = armed ? { ...view.commands, [slot!]: { ...armed, refused: true } } : view.commands
      return update(state, message.teamPath, { pending, commandRequests, commands, error: message.error, failures: message.failures ?? [] })
    }
    // Success retires the dialog's command: a later dialog is a new command.
    const commands = { ...view.commands }
    if (slot) delete commands[slot]
    return update(state, message.teamPath, { pending, commandRequests, commands, error: null, failures: [] })
  }),
}))
