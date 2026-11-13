// Question auto-answer deadlines of Kawai's Claude chat adapter
// (question-auto-answer D2/D4/D5; task 6.1 R5): Kawai owns the timer, the
// recommended answers and the hold; the package's answer path settles a due
// deadline (claudeRuntime.ts passes Kawai's note as its response).
import type { ChatQuestion, ChatQuestionAnswer } from '../../../shared/chat'
import { recommendedAnswers } from '../contentBlocks'
import type { ChatTimerScheduler } from '../timerScheduler'

export interface Deadline {
  answers: Record<string, ChatQuestionAnswer>
  at: string
  waitMs: number
  timer: unknown
}

export class QuestionDeadlines {
  private readonly deadlines = new Map<string, Deadline>()

  constructor(
    private readonly scheduler: ChatTimerScheduler,
    private readonly waitMs: () => number,
    private readonly due: (requestId: string, deadline: Deadline) => void,
  ) {}

  /** Arm a question's deadline, read when it is asked; none without recommended answers or a positive wait. */
  arm(requestId: string, askedAt: string, questions: ChatQuestion[]): Deadline | undefined {
    const waitMs = this.waitMs()
    const answers = recommendedAnswers(questions)
    if (!answers || !Number.isFinite(waitMs) || waitMs <= 0) return undefined
    const deadline: Deadline = { answers, at: new Date(Date.parse(askedAt) + waitMs).toISOString(), waitMs, timer: undefined }
    deadline.timer = this.scheduler.schedule(waitMs, () => {
      if (this.deadlines.get(requestId) !== deadline) return
      deadline.timer = undefined
      this.due(requestId, deadline)
    })
    this.deadlines.set(requestId, deadline)
    return deadline
  }

  get(requestId: string): Deadline | undefined {
    return this.deadlines.get(requestId)
  }

  /** The card's auto-answer view, when a deadline stands. */
  autoAnswer(requestId: string): { autoAnswer: { at: string; answers: Record<string, ChatQuestionAnswer> } } | Record<string, never> {
    const deadline = this.deadlines.get(requestId)
    return deadline ? { autoAnswer: { at: deadline.at, answers: deadline.answers } } : {}
  }

  clear(requestId: string): void {
    const deadline = this.deadlines.get(requestId)
    if (!deadline) return
    this.deadlines.delete(requestId)
    if (deadline.timer !== undefined) this.scheduler.cancel(deadline.timer)
  }

  clearAll(): void {
    for (const requestId of Array.from(this.deadlines.keys())) this.clear(requestId)
  }
}
