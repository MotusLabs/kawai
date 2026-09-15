// workspaceStore.ts - Client-side workspace snapshot state: the latest
// successful snapshot, per-worktree errors, operation results, and persisted
// collapse state keyed by stable worktree id. Malformed payloads never
// clobber the last valid snapshot (stale data stays visible until the server
// sends a good one; on reconnect the server resends the snapshot on open).

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'
import { parseWorkspaceSnapshot } from '../../shared/workspaceValidation'
import type {
  WorkspaceOperationResult,
  WorkspaceSnapshot,
} from '../../shared/workspace'

const MAX_OPERATION_RESULTS = 10

interface WorkspaceState {
  /** Latest successfully parsed workspace snapshot, or null before the first. */
  snapshot: WorkspaceSnapshot | null
  /** Connection-level workspace error (e.g. disconnect); snapshot data stays. */
  lastError: string | null
  /** Recent operation results, newest first, bounded. */
  operationResults: WorkspaceOperationResult[]
  /** Collapsed section keys (change sections by changeSectionKey, worktree sections by worktree id). */
  collapsedSectionIds: string[]

  /** Parse and store a server snapshot; returns false and keeps the previous
   *  snapshot when the payload is malformed. */
  applySnapshot: (payload: unknown) => boolean
  /** Clear the snapshot (server confirmed no workspace data). */
  clearSnapshot: () => void
  setLastError: (error: string | null) => void
  toggleSectionCollapsed: (sectionKey: string) => void
  isSectionCollapsed: (sectionKey: string) => boolean
  recordOperationResult: (result: WorkspaceOperationResult) => void
  clearOperationResult: (operation: WorkspaceOperationResult['operation']) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      snapshot: null,
      lastError: null,
      operationResults: [],
      collapsedSectionIds: [],

      applySnapshot: (payload) => {
        const snapshot = parseWorkspaceSnapshot(payload)
        if (!snapshot) return false
        set({ snapshot, lastError: null })
        return true
      },

      clearSnapshot: () => set({ snapshot: null }),

      setLastError: (error) => set({ lastError: error }),

      toggleSectionCollapsed: (sectionKey) => {
        const { collapsedSectionIds } = get()
        set({
          collapsedSectionIds: collapsedSectionIds.includes(sectionKey)
            ? collapsedSectionIds.filter((id) => id !== sectionKey)
            : [...collapsedSectionIds, sectionKey],
        })
      },

      isSectionCollapsed: (sectionKey) =>
        get().collapsedSectionIds.includes(sectionKey),

      recordOperationResult: (result) => {
        const { operationResults } = get()
        set({ operationResults: [result, ...operationResults].slice(0, MAX_OPERATION_RESULTS) })
      },

      clearOperationResult: (operation) => {
        set({
          operationResults: get().operationResults.filter(
            (result) => result.operation !== operation
          ),
        })
      },
    }),
    {
      name: 'agentboard-workspace',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ collapsedSectionIds: state.collapsedSectionIds }),
    }
  )
)
