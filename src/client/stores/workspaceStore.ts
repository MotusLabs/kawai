// workspaceStore.ts - Client-side workspace snapshot state: the latest
// successful snapshot, per-worktree errors, operation results, and persisted
// collapse state keyed by stable worktree id. Malformed payloads never
// clobber the last valid snapshot (stale data stays visible until the server
// sends a good one; on reconnect the server resends the snapshot on open).

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'
import { parseWorkspaceSnapshot } from '../../shared/workspaceValidation'
import {
  FALLBACK_ARCHIVE_SECTION_KEY,
  type WorkspaceOperationResult,
  type WorkspaceSnapshot,
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
  /**
   * Whether the user has ever expanded the Archive section. Until then it is
   * treated as collapsed on first use (chat-archive design D6); the choice
   * persists once made.
   */
  archiveSectionExpanded: boolean

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
      archiveSectionExpanded: false,

      applySnapshot: (payload) => {
        const snapshot = parseWorkspaceSnapshot(payload)
        if (!snapshot) return false
        set({ snapshot, lastError: null })
        return true
      },

      clearSnapshot: () => set({ snapshot: null }),

      setLastError: (error) => set({ lastError: error }),

      toggleSectionCollapsed: (sectionKey) => {
        const { collapsedSectionIds, archiveSectionExpanded } = get()
        // First-use collapse: the Archive section reads as collapsed until
        // the user expands it once; that expansion is recorded so reloads
        // keep the choice.
        const wasCollapsed =
          sectionKey === FALLBACK_ARCHIVE_SECTION_KEY
            ? collapsedSectionIds.includes(sectionKey) || !archiveSectionExpanded
            : collapsedSectionIds.includes(sectionKey)
        set({
          collapsedSectionIds: wasCollapsed
            ? collapsedSectionIds.filter((id) => id !== sectionKey)
            : [...collapsedSectionIds, sectionKey],
          ...(wasCollapsed && sectionKey === FALLBACK_ARCHIVE_SECTION_KEY
            ? { archiveSectionExpanded: true }
            : {}),
        })
      },

      isSectionCollapsed: (sectionKey) => {
        const { collapsedSectionIds, archiveSectionExpanded } = get()
        if (sectionKey === FALLBACK_ARCHIVE_SECTION_KEY) {
          return collapsedSectionIds.includes(sectionKey) || !archiveSectionExpanded
        }
        return collapsedSectionIds.includes(sectionKey)
      },

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
      partialize: (state) => ({
        collapsedSectionIds: state.collapsedSectionIds,
        archiveSectionExpanded: state.archiveSectionExpanded,
      }),
    }
  )
)
