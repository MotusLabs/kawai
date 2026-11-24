// Set up team wire shapes (starter-team-setup D3), shared by the server's
// setup operation and the Team page: the preview of the starter groups and
// the one result envelope every outcome — refusal, error, success — carries.

/** One starter group as the preview shows it. */
export interface TeamSetupGroup {
  id: string
  label: string
  description: string
  /** Its workers with their per-profile caps, in the template's order. */
  workers: Array<{ profileId: string; cap?: number }>
  max: number
  crossModelReview: boolean
}

export interface TeamSetupPreview {
  /** The project groups directory holds no `*.md` now. */
  available: boolean
  /** `<main-checkout>/.kawai/groups`, where the files would be written. */
  targetDir: string
  groups: TeamSetupGroup[]
  /** One line per starter worker the team's catalog does not define. */
  warnings: string[]
}

export interface TeamSetupResult {
  ok: boolean
  /** File names written, in order. */
  created: string[]
  /** File names that appeared before kawai could create them; their bytes are kept. */
  skipped: string[]
  /** Why nothing (or not everything) was written; absent on success. */
  reason?: 'already-set-up' | 'symlink' | 'unknown-team' | 'error'
  error?: string
}
