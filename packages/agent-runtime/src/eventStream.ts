// One ordered event stream (design §6): every event gets a unique id, the
// stream's identity and the next sequence number, then goes to onEvent. The
// full emitter (stored replay, resumed-stream isolation) is task 5.1; this is
// the minimal ordered form the first driver path needs.
import type { AgentEvent } from './events.js'

type Base = 'id' | 'streamId' | 'sequence' | 'at'
export type EventBody = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, Base> : never) : never

export class EventStream {
  readonly streamId = crypto.randomUUID()
  private sequence = 0

  constructor(private readonly onEvent: (event: AgentEvent) => void) {}

  emit(body: EventBody): void {
    this.sequence += 1
    const event = { ...body, id: crypto.randomUUID(), streamId: this.streamId, sequence: this.sequence, at: new Date().toISOString() } as AgentEvent
    this.onEvent(event)
  }
}
