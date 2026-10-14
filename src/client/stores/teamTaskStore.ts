// Per-chat team task views (team-tasks 7.1/7.2): the team's task list, the
// selected task's detail, and in-flight human actions. Server snapshots are
// authoritative and replace local rows whole; closed views ignore late
// pushes, and a detail push for a task that is no longer selected is dropped.
import { create } from 'zustand'
import type { ServerMessage } from '@shared/types'
import type { SessionDirectoryEntry } from '@shared/team'
import type { TeamTaskDetail, TeamTaskSummary } from '@shared/teamTasks'

export type TaskAction = 'create' | 'amend' | 'note' | 'status'

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
}

export const closedTaskView = (): TaskView => ({
  open: false, loading: false, tasks: [], selectedTaskId: null, detail: null, directory: [], pending: {}, error: null,
})

interface TaskState {
  views: Record<string, TaskView>
  open: (sessionId: string, taskId?: string) => void
  close: (sessionId: string) => void
  select: (sessionId: string, taskId: string | null) => void
  begin: (sessionId: string, requestId: string, action: TaskAction) => void
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
    selectedTaskId: taskId, error: null,
    detail: state.views[sessionId]?.detail?.task.id === taskId ? state.views[sessionId]!.detail : null,
  })),
  begin: (sessionId, requestId, action) => set(state => update(state, sessionId, {
    pending: { ...state.views[sessionId]?.pending, [requestId]: action }, error: null,
  })),
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
    if (message.error) return update(state, message.sessionId, { pending, error: message.error })
    // A task the human just created opens straight into its detail.
    if (action === 'create' && message.task) {
      return update(state, message.sessionId, { pending, error: null, selectedTaskId: message.task.id, detail: null })
    }
    return update(state, message.sessionId, { pending, error: null })
  }),
}))
