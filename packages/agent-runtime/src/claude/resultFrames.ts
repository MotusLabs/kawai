// Result-frame identity (task 4.1, correction A1). A result frame binds at
// most once per session.
//
// - Every result frame's own uuid is recorded before turn binding, including
//   frames the binder then drops or that name unknown prompts. A later
//   arrival of the same frame is dropped, so a UUID-less result that
//   completed one turn cannot complete a later prompted or agent-started
//   turn. A frame that named a queued prompt cannot complete it once it opens.
// - Identity is the frame's uuid (required by the pinned SDK), never its text
//   and never the optional prompt uuids it names.
// - The record lives as long as the session and is never evicted: one id
//   per result frame, the same growth as the turn-result stream.
// - A frame with no uuid of its own is outside the contract. Its identity is
//   unknown, so it is refused rather than allowed to complete a turn.
export class SeenResultFrames {
  private readonly seen = new Set<string>()

  /** `first` once per frame id; `repeat` after that; `unidentified` when the frame has no id. */
  first(frameUuid: unknown): 'first' | 'repeat' | 'unidentified' {
    if (typeof frameUuid !== 'string' || frameUuid === '') return 'unidentified'
    if (this.seen.has(frameUuid)) return 'repeat'
    this.seen.add(frameUuid)
    return 'first'
  }

  get size(): number {
    return this.seen.size
  }
}
