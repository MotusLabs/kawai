// One ordered JSON event stream per driver (design §6, task 5.1). Every
// event gets a fresh unique id, the stream's identity, the next sequence
// number (1, 2, ... without gaps) and its time, and is normalized to a JSON
// value (json.ts), so a JSONL round-trip returns it unchanged. The original
// native, host, turn, tool and message ids in the body are kept as given.
// - A new driver, including one resuming a saved conversation, is a new
//   stream: a stored archive keeps its own ids and order, and the resumed
//   stream never collides with them. Generations of one driver share its
//   stream; the drivers drop a retired generation's frames before any event.
// - Kawai's own payloads (team, workspace) are not in the package's event
//   union; a host adds them in its own envelope.
import type { AgentEvent } from './events.js'
import { toJsonValue } from './json.js'

type Base = 'id' | 'streamId' | 'sequence' | 'at'
export type EventBody = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, Base> : never) : never

export class EventStream {
  readonly streamId = crypto.randomUUID()
  private sequence = 0

  constructor(private readonly onEvent: (event: AgentEvent) => void) {}

  emit(body: EventBody): void {
    this.sequence += 1
    const event = toJsonValue({ ...body, id: crypto.randomUUID(), streamId: this.streamId, sequence: this.sequence, at: new Date().toISOString() }) as unknown as AgentEvent
    this.onEvent(event)
  }
}
