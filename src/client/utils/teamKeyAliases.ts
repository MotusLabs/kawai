// Where a chat's team views went when its team key moved (team-workspace-
// pages D2). A rekey deletes the old key's views, but a reply already in
// flight — above all a one-shot request result — still names the old
// `teamPath`; dropped, it would leave its action pending forever. The router
// sends such a reply to the view's new key, and only when no view exists
// under the old key any more, so a live view there always wins.
const aliases = new Map<string, string>()

export function aliasTeamKey(from: string, to: string): void {
  if (from === to) return
  // A later move of the new key carries earlier aliases along with it.
  for (const [key, target] of aliases) if (target === from) aliases.set(key, to)
  aliases.set(from, to)
  aliases.delete(to)
}

/** The key a reply for `teamPath` belongs to, given the views that exist now. */
export function routedTeamPath(teamPath: string, views: Record<string, unknown>): string {
  if (views[teamPath]) return teamPath
  return aliases.get(teamPath) ?? teamPath
}

/** Forget every alias (tests). */
export function clearTeamKeyAliases(): void {
  aliases.clear()
}
