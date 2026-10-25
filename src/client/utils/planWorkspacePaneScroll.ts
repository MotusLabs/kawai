// Per-team pane scroll retention (plan-workspace 7.1, design D8): a pane's
// scroll position survives within-client navigation — a tab switch unmounts
// the workspace and this module map restores it on return. Client-local
// memory: never sent to the server, gone on reload, which is the same
// lifetime the composer drafts keep outside their per-session store.
const positions = new Map<string, number>()

const keyOf = (teamKey: string, pane: string): string => `${teamKey}\0${pane}`

/** The remembered scroll top of one pane, 0 when it was never scrolled. */
export const paneScrollOf = (teamKey: string, pane: string): number =>
  positions.get(keyOf(teamKey, pane)) ?? 0

/** Remember one pane's scroll top (called from the pane's onScroll). */
export const setPaneScroll = (teamKey: string, pane: string, top: number): void => {
  positions.set(keyOf(teamKey, pane), top)
}

/** Reset for tests. */
export const clearPaneScrollsForTests = (): void => {
  positions.clear()
}
