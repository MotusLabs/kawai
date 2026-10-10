// updateStore.ts - client-side update availability. Seeded from server-info
// for first paint and replaced by `update-state` pushes so the header chip
// appears and clears without a reload. Also owns the update panel's open
// state: the chip and the panel are siblings in different trees, and the
// panel closes itself when the target clears (update applied or withdrawn).
import { create } from 'zustand'
import type { ServerMessage, UpdateState } from '@shared/types'

export interface UpdateStore {
  update: UpdateState | null
  panelOpen: boolean
  /** Seed from the `/api/server-info` payload. */
  setFromServerInfo(update: UpdateState | null | undefined): void
  /** Apply a server push (`update-state`). */
  apply(message: ServerMessage): void
  openPanel(): void
  closePanel(): void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  update: null,
  panelOpen: false,

  setFromServerInfo: (update) => set({ update: update ?? null }),

  apply: (message) => {
    if (message.type !== 'update-state') return
    set((state) => ({
      update: message.update,
      // The update is gone (applied, withdrawn, or base caught up): an open
      // panel has nothing left to offer.
      panelOpen: message.update.target === null ? false : state.panelOpen,
    }))
  },

  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
}))
