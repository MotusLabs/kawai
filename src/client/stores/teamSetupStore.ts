// Set up team on the Members tab (starter-team-setup D3), per team key: the
// preview the server answered, whether a preview or run is waiting for its
// answer, and the last run's envelope (created, skipped, refusal). Whether the
// action is offered at all is the workspace snapshot's `setupAvailable`, so
// every view follows a push; this store keeps only this page's interaction.
// Cancelling drops the preview and sends nothing: the server wrote nothing yet.
// A dropped connection never answers, so the app-wide disconnect handler
// releases the waits (`connectionWaits.ts`); a shown preview or result stays.
import { create } from 'zustand'
import type { TeamSetupPreview, TeamSetupResult } from '@shared/teamSetup'

export interface TeamSetupState {
  /** A preview or a run was sent and its answer has not arrived. */
  pending: 'preview' | 'run' | null
  /** The preview being confirmed; null when closed. */
  preview: TeamSetupPreview | null
  /** The last run's answer, or a failed preview's error as a refusal. */
  result: TeamSetupResult | null
}

const IDLE: TeamSetupState = { pending: null, preview: null, result: null }

interface TeamSetupStoreState {
  setups: Record<string, TeamSetupState>
  beginPreview: (teamKey: string) => void
  applyPreview: (teamKey: string, answer: { ok: true; preview: TeamSetupPreview } | { ok: false; error: string }) => void
  cancel: (teamKey: string) => void
  beginRun: (teamKey: string) => void
  applyResult: (teamKey: string, result: TeamSetupResult) => void
  dropPending: () => void
}

export const useTeamSetupStore = create<TeamSetupStoreState>(set => {
  const update = (teamKey: string, change: (current: TeamSetupState) => TeamSetupState) =>
    set(state => ({ setups: { ...state.setups, [teamKey]: change(state.setups[teamKey] ?? IDLE) } }))
  return {
    setups: {},
    beginPreview: teamKey => update(teamKey, () => ({ pending: 'preview', preview: null, result: null })),
    applyPreview: (teamKey, answer) => update(teamKey, current => answer.ok
      ? { ...current, pending: null, preview: answer.preview }
      : { pending: null, preview: null, result: { ok: false, reason: 'error', error: answer.error, created: [], skipped: [] } }),
    cancel: teamKey => update(teamKey, () => IDLE),
    beginRun: teamKey => update(teamKey, current => ({ ...current, pending: 'run' })),
    applyResult: (teamKey, result) => update(teamKey, () => ({ pending: null, preview: null, result })),
    dropPending: () => set(state => Object.values(state.setups).some(setup => setup.pending !== null)
      ? { setups: Object.fromEntries(Object.entries(state.setups).map(([key, setup]) => [key, { ...setup, pending: null }])) }
      : state),
  }
})
