// Per-team, per-plan pane scroll retention (plan-workspace 7.1 r2, design
// D8): a pane's scroll position survives within-client navigation — a tab
// switch unmounts the workspace and this module map restores it on return —
// and isolates by plan, so Plan A's map position never leaks into Plan B.
// Client-local memory: never sent to the server, gone on reload, which is
// the same lifetime the composer drafts keep outside their per-session
// store.
const positions = new Map<string, number>()

const keyOf = (teamKey: string, planId: string, pane: string): string => `${teamKey}\0${planId}\0${pane}`

/** The remembered scroll top of one pane, 0 when it was never scrolled. */
export const paneScrollOf = (teamKey: string, planId: string, pane: string): number =>
  positions.get(keyOf(teamKey, planId, pane)) ?? 0

/** Remember one pane's scroll top (called from the pane's onScroll). */
export const setPaneScroll = (teamKey: string, planId: string, pane: string, top: number): void => {
  positions.set(keyOf(teamKey, planId, pane), top)
}

/** Reset for tests. */
export const clearPaneScrollsForTests = (): void => {
  positions.clear()
}
