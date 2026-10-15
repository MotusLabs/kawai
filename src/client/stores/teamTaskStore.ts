// Per-team task views (team-tasks 7.1/7.2, task-assignment 5.3): the
// team's task list, the selected task's detail, and in-flight human actions.
// Server snapshots are authoritative and replace local rows whole; closed
// views ignore late pushes, and a detail push for a task that is no longer
// selected is dropped. The create/assign form draft and its request key live
// here — never in component state — so a refusal, a reconnect, or a remount
// keeps every entered field, and a retry reuses the same key: the server
// replays the prior outcome instead of duplicating a task or an instruction.
// Publication and notify command keys (task-revision-publication D2/D4) live
// here too, per armed slot: reused while the payload is unchanged — a resend
// after a reconnect replays — and cleared when the server answers success, so
// a later Retry notification is a new command.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { SessionDirectoryEntry } from '@shared/team'
import type { HumanTaskDetail, TaskDispatchPreview, TaskTargetOptions, TeamTaskSummary } from '@shared/teamTasks'

export type TaskAction = 'create' | 'create-assign' | 'assign' | 'draft' | 'publish' | 'notify' | 'note' | 'status' | 'handoff' | 'accept' | 'release'

/** An armed publish or notify command: its key and the payload it names. */
export interface ArmedCommand {
  requestKey: string
  payload: string
}

/** The create/assign form, kept across failures and reconnects (5.3). */
export interface TaskFormDraft {
  title: string
  direction: string
  acceptance: string
  parentId: string
  worktree: string
  openspecChange: string
  /** A plan change to link (durable-plans D9): both or neither; '' = no link. */
  planId: string
  planChange: string
  /** The assignment target's kind; '' = none chosen (plain Create task). */
  targetKind: '' | 'group' | 'session'
  targetId: string
  instruction: string
}

export const emptyDraft = (): TaskFormDraft => ({
  title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '', planId: '', planChange: '',
  targetKind: '', targetId: '', instruction: '',
})

/**
 * One armed create intent and its stable request key (task-assignment D4).
 * `taskId` is set once the create leg committed — from then on only the
 * dispatch-side retry is offered, never a repeated create. A refused assign
 * keeps the flow (`assignFailed`) so **Retry assignment** reuses both the
 * task and the key.
 */
export interface TaskCreateFlow {
  requestKey: string
  mode: 'create' | 'create-and-assign'
  /** The committed task; null until the create leg succeeds. */
  taskId: string | null
  /** The last assign leg was refused: the form offers Retry assignment. */
  assignFailed: boolean
  /** The dispatch payload the key was armed for, once its leg was sent. */
  sentPayload?: { targetKind: 'group' | 'session'; targetId: string; instruction: string }
  /** The create payload the key was armed for, once its leg was sent. */
  sentCreatePayload?: TaskCreatePayload
}

/** The normalized create fields a request key names (S1: re-key on change). */
export interface TaskCreatePayload {
  title: string
  direction: string
  acceptance: string | null
  parentId: string | null
  worktree: string | null
  openspecChange: string | null
  planId: string | null
  planChange: string | null
}

export interface TaskView {
  open: boolean
  loading: boolean
  tasks: TeamTaskSummary[]
  /** The task whose detail is shown; null = the list. */
  selectedTaskId: string | null
  /** The human's view of the task: detail plus its draft. */
  detail: HumanTaskDetail | null
  /** Last known identity of killed participants named by its messages. */
  directory: SessionDirectoryEntry[]
  /** Actions awaiting their `team-task-result`, by request id. */
  pending: Record<string, TaskAction>
  /** The last refused action's message, until the next action or selection. */
  error: string | null
  /** The create/assign form draft; survives refusals and reconnects. */
  draft: TaskFormDraft
  /** The armed create intent with its request key; null when idle/complete. */
  flow: TaskCreateFlow | null
  /** The last dispatch preview, shown until the target changes. */
  preview: TaskDispatchPreview | null
  previewPending: Record<string, true>
  /** The pickers' team-scoped worktrees and changes (team-task-targets). */
  targets: TaskTargetOptions | null
  targetsLoading: boolean
  /** Armed publish/notify commands by slot (`publish:<task>`, `notify:<task>:<revision>`); kept across reconnects. */
  commands: Record<string, ArmedCommand>
  /** Which slot each pending publish/notify request was sent under, by request id. */
  commandRequests: Record<string, string>
}

export const closedTaskView = (): TaskView => ({
  open: false, loading: false, tasks: [], selectedTaskId: null, detail: null, directory: [], pending: {}, error: null,
  draft: emptyDraft(), flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false,
  commands: {}, commandRequests: {},
})

interface TaskState {
  views: Record<string, TaskView>
  open: (teamKey: string, taskId?: string) => void
  close: (teamKey: string) => void
  /**
   * Move a view to the chat's new team key (team-workspace-pages D2): a key
   * changes when workspace discovery first places the chat in a repository.
   * A view already open under the new key wins; the old one is dropped.
   */
  rekey: (from: string, to: string) => void
  select: (teamKey: string, taskId: string | null) => void
  begin: (teamKey: string, requestId: string, action: TaskAction) => void
  /**
   * The command key for a slot: the armed one while the payload is the same
   * (a resend replays), else a fresh one. Records the request it goes out with.
   */
  command: (teamKey: string, slot: string, payload: string, requestId: string) => string
  setDraft: (teamKey: string, patch: Partial<TaskFormDraft>) => void
  /** Arm a create intent with a freshly minted request key. */
  armFlow: (teamKey: string, mode: TaskCreateFlow['mode']) => void
  /** Clear the last assign refusal so the retry effect re-sends it. */
  retryAssign: (teamKey: string) => void
  /** Record the dispatch payload the armed key is being used for. */
  flowSendAssign: (teamKey: string, payload: NonNullable<TaskCreateFlow['sentPayload']>) => void
  /** Record the create payload the armed key is being used for. */
  flowSendCreate: (teamKey: string, payload: TaskCreatePayload) => void
  /**
   * The connection came back: results for anything still pending were lost
   * with it, so their waiters are dropped. The armed flow keeps its request
   * key — the dispatch effect re-sends the assign leg under it (the server
   * replays the committed outcome), and the human's resubmit of a create
   * reuses the armed key the same way.
   */
  reconnected: (teamKey: string) => void
  beginPreview: (teamKey: string, requestId: string) => void
  applyPreviewResult: (message: Extract<ServerMessage, { type: 'team-task-preview-result' }>) => void
  beginTargets: (teamKey: string) => void
  applyTargetsResult: (message: Extract<ServerMessage, { type: 'team-task-targets-result' }>) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-tasks-snapshot' }>) => void
  applyDetail: (message: Extract<ServerMessage, { type: 'team-task-detail' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-task-result' }>) => void
}

const update = (state: TaskState, teamKey: string, patch: Partial<TaskView>) => {
  const view = state.views[teamKey]
  if (!view?.open) return state
  return { views: { ...state.views, [teamKey]: { ...view, ...patch } } }
}

export const useTeamTaskStore = create<TaskState>(set => ({
  views: {},
  open: (teamKey, taskId) => set(state => {
    const view = state.views[teamKey] ?? closedTaskView()
    const selectedTaskId = taskId ?? view.selectedTaskId
    return { views: { ...state.views, [teamKey]: {
      ...view, open: true, loading: !view.open, selectedTaskId,
      detail: view.detail?.task.id === selectedTaskId ? view.detail : null,
    } } }
  }),
  rekey: (from, to) => set(state => {
    const view = state.views[from]
    if (!view || from === to) return state
    const views = { ...state.views }
    delete views[from]
    if (!views[to]) views[to] = view
    return { views }
  }),
  close: teamKey => set(state => {
    const views = { ...state.views }
    delete views[teamKey]
    return { views }
  }),
  select: (teamKey, taskId) => set(state => update(state, teamKey, {
    selectedTaskId: taskId, error: null, preview: null,
    detail: state.views[teamKey]?.detail?.task.id === taskId ? state.views[teamKey]!.detail : null,
  })),
  begin: (teamKey, requestId, action) => set(state => update(state, teamKey, {
    pending: { ...state.views[teamKey]?.pending, [requestId]: action }, error: null,
  })),
  command: (teamKey, slot, payload, requestId) => {
    let requestKey: string = crypto.randomUUID()
    set(state => {
      const view = state.views[teamKey]
      if (!view?.open) return state
      const armed = view.commands[slot]
      if (armed && armed.payload === payload) requestKey = armed.requestKey
      return { views: { ...state.views, [teamKey]: { ...view,
        commands: { ...view.commands, [slot]: { requestKey, payload } },
        commandRequests: { ...view.commandRequests, [requestId]: slot },
      } } }
    })
    return requestKey
  },
  setDraft: (teamKey, patch) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return { views: { ...state.views, [teamKey]: { ...view, draft: { ...view.draft, ...patch } } } }
  }),
  armFlow: (teamKey, mode) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return { views: { ...state.views, [teamKey]: { ...view,
      flow: { requestKey: crypto.randomUUID(), mode, taskId: null, assignFailed: false },
      error: null,
    } } }
  }),
  retryAssign: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open || !view.flow?.assignFailed) return state
    // Reuse the key for a true retry (the server replays the committed
    // outcome). An edited target or instruction is a new intent on the same
    // task — the prior dispatch wrote nothing, so a fresh key is safe and
    // the old one would be refused for a different payload.
    const draft = view.draft
    const payload = { targetKind: draft.targetKind as 'group' | 'session', targetId: draft.targetId, instruction: draft.instruction }
    const changed = view.flow.sentPayload &&
      (view.flow.sentPayload.targetKind !== payload.targetKind || view.flow.sentPayload.targetId !== payload.targetId ||
        view.flow.sentPayload.instruction !== payload.instruction)
    const flow = { ...view.flow, assignFailed: false, sentPayload: payload,
      ...(changed ? { requestKey: crypto.randomUUID() } : {}) }
    return { views: { ...state.views, [teamKey]: { ...view, flow, error: null } } }
  }),
  beginPreview: (teamKey, requestId) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open) return state
    return { views: { ...state.views, [teamKey]: { ...view, previewPending: { ...view.previewPending, [requestId]: true } } } }
  }),
  applyPreviewResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    const previewPending = { ...view.previewPending }
    delete previewPending[message.requestId]
    return { views: { ...state.views, [message.teamPath]: { ...view, previewPending,
      preview: message.error || message.preview === undefined ? null : message.preview,
      error: message.error ?? view.error,
    } } }
  }),
  flowSendAssign: (teamKey, payload) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open || !view.flow) return state
    // Set on the first send only: re-sends under the same key carry the same
    // payload by construction, and retryAssign re-keys and re-records on a
    // changed intent — overwriting here would blur which payload the key names.
    if (view.flow.sentPayload !== undefined) return state
    return { views: { ...state.views, [teamKey]: { ...view, flow: { ...view.flow, sentPayload: payload } } } }
  }),
  flowSendCreate: (teamKey, payload) => set(state => {
    const view = state.views[teamKey]
    if (!view?.open || !view.flow) return state
    if (view.flow.sentCreatePayload !== undefined) return state
    return { views: { ...state.views, [teamKey]: { ...view, flow: { ...view.flow, sentCreatePayload: payload } } } }
  }),
  reconnected: teamKey => set(state => {
    const view = state.views[teamKey]
    if (!view?.open || Object.keys(view.pending).length === 0) return state
    return { views: { ...state.views, [teamKey]: { ...view, pending: {} } } }
  }),
  beginTargets: teamKey => set(state => update(state, teamKey, { targetsLoading: true })),
  applyTargetsResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    return { views: { ...state.views, [message.teamPath]: { ...view,
      targetsLoading: false,
      targets: message.targets ?? view.targets,
      error: message.error ?? view.error,
    } } }
  }),
  applySnapshot: message => set(state => update(state, message.teamPath, { loading: false, tasks: message.tasks })),
  applyDetail: message => set(state =>
    state.views[message.teamPath]?.selectedTaskId === message.detail.task.id
      ? update(state, message.teamPath, { detail: message.detail, directory: message.directory })
      : state),
  applyResult: message => set(state => {
    const view = state.views[message.teamPath]
    if (!view?.open) return state
    const pending = { ...view.pending }
    const action = pending[message.requestId]
    delete pending[message.requestId]
    // A command that landed is done: the next press is a new intent.
    const slot = view.commandRequests[message.requestId]
    if (slot !== undefined) {
      const commandRequests = { ...view.commandRequests }
      delete commandRequests[message.requestId]
      const commands = { ...view.commands }
      if (!message.error) delete commands[slot]
      state = { ...state, views: { ...state.views, [message.teamPath]: { ...view, commands, commandRequests } } }
    }
    if (message.error) {
      // A refused assign keeps the flow armed for Retry assignment; any
      // refusal keeps the draft exactly as entered.
      const flow = action === 'assign' && view.flow ? { ...view.flow, assignFailed: true } : view.flow
      return update(state, message.teamPath, { pending, error: message.error, flow })
    }
    if (action === 'assign') {
      // The dispatch leg completed the whole intent (or a detail-side assign
      // succeeded): clear the form and open the task.
      if (view.flow) return update(state, message.teamPath, {
        pending, error: null, draft: emptyDraft(), flow: null, preview: null,
        selectedTaskId: view.flow.taskId ?? view.selectedTaskId,
        detail: view.flow.taskId ? null : view.detail,
      })
      return update(state, message.teamPath, { pending, error: null, preview: null })
    }
    if ((action === 'create' || action === 'create-assign') && message.task) {
      // A create-and-assign flow keeps the form until its assign leg lands;
      // its create leg only records the committed task for the retry.
      if (view.flow && action === 'create-assign') {
        return update(state, message.teamPath, { pending, error: null, flow: { ...view.flow, taskId: message.task.id } })
      }
      return update(state, message.teamPath, { pending, error: null, draft: emptyDraft(), flow: null, preview: null, selectedTaskId: message.task.id, detail: null })
    }
    return update(state, message.teamPath, { pending, error: null })
  }),
}))
