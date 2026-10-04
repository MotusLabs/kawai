// Revalidate candidates after async log matching before persisting a wake claim.
import type { Session } from '../../shared/types'

export async function revalidateRematchTarget(
  matched: Session,
  probe: (target: string) => Promise<string | null>,
  getSession: (id: string) => Session | undefined,
): Promise<Session | null> {
  // A successful display-message confirms the target still exists in tmux.
  // Read registry data after the probe too, since it also yields to refreshes.
  const windowId = await probe(matched.tmuxWindow)
  if (!windowId?.trim()) return null
  const current = getSession(matched.id)
  if (!current || current.remote || current.tmuxWindow !== matched.tmuxWindow) {
    return null
  }
  return current
}
