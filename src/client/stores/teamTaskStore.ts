// Per-chat team task views (team-tasks 7.1/7.2, task-assignment 5.3): the
// team's task list, the selected task's detail, and in-flight human actions.
// Server snapshots are authoritative and replace local rows whole; closed
// views ignore late pushes, and a detail push for a task that is no longer
// selected is dropped. The create/assign form draft and its request key live
// here — never in component state — so a refusal, a reconnect, or a remount
// keeps every entered field, and a retry reuses the same key: the server
// replays the prior outcome instead of duplicating a task or an instruction.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { SessionDirectoryEntry } from '@shared/team'
import type { TaskDispatchPreview, TaskTargetOptions, TeamTaskDetail, TeamTaskSummary } from '@shared/teamTasks'

export type TaskAction = 'create' | 'create-assign' | 'assign' | 'amend' | 'note' | 'status'

/** The create/assign form, kept across failures and reconnects (5.3). */
export interface TaskFormDraft {
  title: string
  direction: string
  acceptance: string
  parentId: string
  worktree: string
  openspecChange: string
  /** The assignment target's kind; '' = none chosen (plain Create task). */
  targetKind: '' | 'group' | 'session'
  targetId: string
  instruction: string
}

export const emptyDraft = (): TaskFormDraft => ({
  title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '',
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
}

export interface TaskView {
  open: boolean
  loading: boolean
  tasks: TeamTaskSummary[]
  /** The task whose detail is shown; null = the list. */
  selectedTaskId: string | null
  detail: TeamTaskDetail | null
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
}

export const closedTaskView = (): TaskView => ({
  open: false, loading: false, tasks: [], selectedTaskId: null, detail: null, directory: [], pending: {}, error: null,
  draft: emptyDraft(), flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false,
})

interface TaskState {
  views: Record<string, TaskView>
  open: (sessionId: string, taskId?: string) => void
  close: (sessionId: string) => void
  select: (sessionId: string, taskId: string | null) => void
  begin: (sessionId: string, requestId: string, action: TaskAction) => void
  setDraft: (sessionId: string, patch: Partial<TaskFormDraft>) => void
  /** Arm a create intent with a freshly minted request key. */
  armFlow: (sessionId: string, mode: TaskCreateFlow['mode']) => void
  /** Clear the last assign refusal so the retry effect re-sends it. */
  retryAssign: (sessionId: string) => void
  /** Record the dispatch payload the armed key is being used for. */
  flowSendAssign: (sessionId: string, payload: NonNullable<TaskCreateFlow['sentPayload']>) => void
  /**
   * The connection came back: results for anything still pending were lost
   * with it, so their waiters are dropped. The armed flow keeps its request
   * key — the dispatch effect re-sends the assign leg under it (the server
   * replays the committed outcome), and the human's resubmit of a create
   * reuses the armed key the same way.
   */
  reconnected: (sessionId: string) => void
  beginPreview: (sessionId: string, requestId: string) => void
  applyPreviewResult: (message: Extract<ServerMessage, { type: 'team-task-preview-result' }>) => void
  beginTargets: (sessionId: string) => void
  applyTargetsResult: (message: Extract<ServerMessage, { type: 'team-task-targets-result' }>) => void
  applySnapshot: (message: Extract<ServerMessage, { type: 'team-tasks-snapshot' }>) => void
  applyDetail: (message: Extract<ServerMessage, { type: 'team-task-detail' }>) => void
  applyResult: (message: Extract<ServerMessage, { type: 'team-task-result' }>) => void
}

const update = (state: TaskState, sessionId: string, patch: Partial<TaskView>) => {
  const view = state.views[sessionId]
  if (!view?.open) return state
  return { views: { ...state.views, [sessionId]: { ...view, ...patch } } }
}

export const useTeamTaskStore = create<TaskState>(set => ({
  views: {},
  open: (sessionId, taskId) => set(state => {
    const view = state.views[sessionId] ?? closedTaskView()
    const selectedTaskId = taskId ?? view.selectedTaskId
    return { views: { ...state.views, [sessionId]: {
      ...view, open: true, loading: !view.open, selectedTaskId,
      detail: view.detail?.task.id === selectedTaskId ? view.detail : null,
    } } }
  }),
  close: sessionId => set(state => {
    const views = { ...state.views }
    delete views[sessionId]
    return { views }
  }),
  select: (sessionId, taskId) => set(state => update(state, sessionId, {
    selectedTaskId: taskId, error: null, preview: null,
    detail: state.views[sessionId]?.detail?.task.id === taskId ? state.views[sessionId]!.detail : null,
  })),
  begin: (sessionId, requestId, action) => set(state => update(state, sessionId, {
    pending: { ...state.views[sessionId]?.pending, [requestId]: action }, error: null,
  })),
  setDraft: (sessionId, patch) => set(state => {
    const view = state.views[sessionId]
    if (!view?.open) return state
    return { views: { ...state.views, [sessionId]: { ...view, draft: { ...view.draft, ...patch } } } }
  }),
  armFlow: (sessionId, mode) => set(state => {
    const view = state.views[sessionId]
    if (!view?.open) return state
    return { views: { ...state.views, [sessionId]: { ...view,
      flow: { requestKey: crypto.randomUUID(), mode, taskId: null, assignFailed: false },
      error: null,
    } } }
  }),
  retryAssign: sessionId => set(state => {
    const view = state.views[sessionId]
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
    return { views: { ...state.views, [sessionId]: { ...view, flow, error: null } } }
  }),
  beginPreview: (sessionId, requestId) => set(state => {
    const view = state.views[sessionId]
    if (!view?.open) return state
    return { views: { ...state.views, [sessionId]: { ...view, previewPending: { ...view.previewPending, [requestId]: true } } } }
  }),
  applyPreviewResult: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    const previewPending = { ...view.previewPending }
    delete previewPending[message.requestId]
    return { views: { ...state.views, [message.sessionId]: { ...view, previewPending,
      preview: message.error || message.preview === undefined ? null : message.preview,
      error: message.error ?? view.error,
    } } }
  }),
  flowSendAssign: (sessionId, payload) => set(state => {
    const view = state.views[sessionId]
    if (!view?.open || !view.flow) return state
    // Set on the first send only: re-sends under the same key carry the same
    // payload by construction, and retryAssign re-keys and re-records on a
    // changed intent — overwriting here would blur which payload the key names.
    if (view.flow.sentPayload !== undefined) return state
    return { views: { ...state.views, [sessionId]: { ...view, flow: { ...view.flow, sentPayload: payload } } } }
  }),
  reconnected: sessionId => set(state => {
    const view = state.views[sessionId]
    if (!view?.open || Object.keys(view.pending).length === 0) return state
    return { views: { ...state.views, [sessionId]: { ...view, pending: {} } } }
  }),
  beginTargets: sessionId => set(state => update(state, sessionId, { targetsLoading: true })),
  applyTargetsResult: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    return { views: { ...state.views, [message.sessionId]: { ...view,
      targetsLoading: false,
      targets: message.targets ?? view.targets,
      error: message.error ?? view.error,
    } } }
  }),
  applySnapshot: message => set(state => update(state, message.sessionId, { loading: false, tasks: message.tasks })),
  applyDetail: message => set(state =>
    state.views[message.sessionId]?.selectedTaskId === message.detail.task.id
      ? update(state, message.sessionId, { detail: message.detail, directory: message.directory })
      : state),
  applyResult: message => set(state => {
    const view = state.views[message.sessionId]
    if (!view?.open) return state
    const pending = { ...view.pending }
    const action = pending[message.requestId]
    delete pending[message.requestId]
    if (message.error) {
      // A refused assign keeps the flow armed for Retry assignment; any
      // refusal keeps the draft exactly as entered.
      const flow = action === 'assign' && view.flow ? { ...view.flow, assignFailed: true } : view.flow
      return update(state, message.sessionId, { pending, error: message.error, flow })
    }
    if (action === 'assign') {
      // The dispatch leg completed the whole intent (or a detail-side assign
      // succeeded): clear the form and open the task.
      if (view.flow) return update(state, message.sessionId, {
        pending, error: null, draft: emptyDraft(), flow: null, preview: null,
        selectedTaskId: view.flow.taskId ?? view.selectedTaskId,
        detail: view.flow.taskId ? null : view.detail,
      })
      return update(state, message.sessionId, { pending, error: null, preview: null })
    }
    if ((action === 'create' || action === 'create-assign') && message.task) {
      // A create-and-assign flow keeps the form until its assign leg lands;
      // its create leg only records the committed task for the retry.
      if (view.flow && action === 'create-assign') {
        return update(state, message.sessionId, { pending, error: null, flow: { ...view.flow, taskId: message.task.id } })
      }
      return update(state, message.sessionId, { pending, error: null, draft: emptyDraft(), flow: null, preview: null, selectedTaskId: message.task.id, detail: null })
    }
    return update(state, message.sessionId, { pending, error: null })
  }),
}))
