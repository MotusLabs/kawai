// Attempt manifest hashing (plan-execution design D8). Server-side only, like
// plan hashing: sha256 over the shared canonical serialization, so the hash
// is stable under key order and the client only displays it.
import { createHash } from 'node:crypto'
import { manifestHashInput, type AttemptManifest } from '../../../shared/planExecution'

export function hashManifest(manifest: AttemptManifest): string {
  return createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
}
