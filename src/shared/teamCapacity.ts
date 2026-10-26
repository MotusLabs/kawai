// The team's capacity answer (dispatch-worker-choice D6), shared by the
// `team_capacity` agent tool and the human's worker picker
// (`team-task-capacity`): ids, counts, usage windows, and times only — never
// an env value, credential, config dir, path, or URL (I5).
import type { RouteUsage } from './routing'

export interface CapacityWorker {
  /** The model key (the stored profile id). */
  model: string
  provider: string
  /** The group's cap on live members of this worker; null when uncapped. */
  cap: number | null
  /** Live members on this worker, pending spawn reservations included. */
  live: number
  /** The worker's effective cooldown end (ISO); null when not cooling. */
  cooldownUntil: string | null
  /** Set when an out-of-credit limit decides that end. */
  credit?: true
}

export interface CapacityGroup {
  id: string
  /** Live-member cap of the whole group. */
  max: number
  /** Live members, pending spawn reservations included. */
  live: number
  strategy: 'first-available' | 'profile-order'
  /** In preference order. */
  workers: CapacityWorker[]
}

export interface CapacityProvider {
  id: string
  label: string | null
  /** The latest report kawai holds; null = unknown (none since the server started). */
  usage: RouteUsage | null
  /** The provider's own cooldown end (ISO); null when not cooling. */
  cooldownUntil: string | null
  /** Other team providers detected as drawing on the same login; empty = not detected. */
  sharesLoginWith: string[]
}

export interface TeamCapacityAnswer {
  computedAt: string
  groups: CapacityGroup[]
  providers: CapacityProvider[]
}
