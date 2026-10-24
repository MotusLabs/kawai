// Interactive pending requests are authoritative server snapshots/events.
// A question with a standing auto-answer deadline shows what will be chosen
// and when, offers Wait for me, and holds the deadline on the form's first
// edit so the timeout never overrides an unsubmitted answer (D4/D6).
import { useRef, useState } from 'react'
import type { ChatPendingRequest, ChatQuestionAnswer } from '@shared/chat'
import type { SendClientMessage } from '@shared/types'
import { autoAnswerChoiceLabels, formatCountdown } from './autoAnswerLabels'
import { useTickingClock } from './chatElapsed'

function QuestionForm({ request, sessionId, sendMessage, disabled }: {
  request: Extract<ChatPendingRequest, { kind: 'question' }>
  sessionId: string
  sendMessage: SendClientMessage
  disabled: boolean
}) {
  const [answers, setAnswers] = useState<Record<string, ChatQuestionAnswer>>({})
  // One hold per form, sent on the first edit while a deadline stands (D4);
  // once sent — or when no deadline ever stood — later edits are ordinary.
  const holdSent = useRef(false)
  const update = (question: string, answer: ChatQuestionAnswer) => {
    if (!holdSent.current) {
      holdSent.current = true
      if (request.autoAnswer) {
        sendMessage({ type: 'chat-question-hold', sessionId, requestId: request.requestId })
      }
    }
    setAnswers(current => ({ ...current, [question]: answer }))
  }
  // The countdown ticks on the client clock while the deadline stands; the
  // server's timer decides, so 0:00 just waits for the resolution (D6).
  const now = useTickingClock(request.autoAnswer !== undefined)
  return <form className="space-y-3 border border-border bg-elevated p-4" onSubmit={event => {
    event.preventDefault()
    sendMessage({ type: 'chat-answer', sessionId, requestId: request.requestId, answers })
  }}>
    {request.questions.map(question => {
      const answer = answers[question.question] ?? {}
      return <fieldset key={question.question} disabled={disabled}>
        <legend className="mb-2 text-chat-body font-medium">{question.question}</legend>
        <div className="space-y-2">
          {question.options.map(option => <label key={option.label} className="flex items-start gap-2 text-chat-body">
            <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${request.requestId}-${question.header}`}
              checked={answer.options?.includes(option.label) ?? false}
              onChange={event => update(question.question, question.multiSelect
                ? { ...answer, options: event.target.checked ? [...(answer.options ?? []), option.label] : (answer.options ?? []).filter(value => value !== option.label) }
                // Single-select: an option replaces the user's own text.
                : { options: [option.label] })} />
            <span>{option.label}{option.description && <span className="block text-chat-meta text-secondary">{option.description}</span>}</span>
          </label>)}
          {/* Codex F3: free text where Codex allows another answer (absent,
              as on every Claude question, keeps it) and always when the
              question offers no options — text is then its only answer; a
              secret answer is masked in the input, which stays masked on
              the answered card until the resolved event removes it. */}
          {(question.options.length === 0 || question.isOther !== false) && <input className="input chat-composer text-chat-body" aria-label={`Free-text answer: ${question.question}`}
            type={question.isSecret ? 'password' : undefined}
            placeholder={question.multiSelect ? 'Add your own answer' : 'Or type your own answer'}
            value={answer.text ?? ''} onChange={event => update(question.question, question.multiSelect || !event.target.value.trim()
              ? { ...answer, text: event.target.value }
              // Single-select: typing an answer replaces the chosen option.
              : { text: event.target.value })} />}
        </div>
      </fieldset>
    })}
    {request.autoAnswer && <div className="flex items-center gap-3" data-testid="auto-answer-deadline">
      <p className="text-chat-meta text-secondary" data-testid="auto-answer-countdown">
        Will choose {autoAnswerChoiceLabels(request.autoAnswer.answers)} in {formatCountdown(request.autoAnswer.at, now)}
      </p>
      <button type="button" className="btn text-chat-meta" disabled={disabled}
        onClick={() => sendMessage({ type: 'chat-question-hold', sessionId, requestId: request.requestId })}>
        Wait for me
      </button>
    </div>}
    <button className="btn btn-primary text-chat-meta" disabled={disabled || request.questions.some(question => {
      const answer = answers[question.question]
      return !answer?.text?.trim() && !answer?.options?.length
    })}>Submit answers</button>
  </form>
}

export default function ChatRequests({ requests, sessionId, sendMessage, disabled }: {
  requests: ChatPendingRequest[]; sessionId: string; sendMessage: SendClientMessage; disabled: boolean
}) {
  return <div className="space-y-3" data-testid="chat-requests">
    {requests.map(request => request.kind === 'question'
      ? <QuestionForm key={request.requestId} request={request} sessionId={sessionId} sendMessage={sendMessage} disabled={disabled} />
      : <section key={request.requestId} className="border border-border bg-elevated p-4">
        <h3 className="text-chat-body font-medium">Approve {request.tool}?</h3>
        <p className="mt-1 truncate text-chat-meta text-secondary">{JSON.stringify(request.input)}</p>
        <details className="my-3 text-chat-meta"><summary>Arguments</summary>
          <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(request.input, null, 2)}</pre>
        </details>
        <div className="flex gap-2">{(['allow', 'deny'] as const).map(decision =>
          <button key={decision} disabled={disabled} className={`btn text-chat-meta ${decision === 'allow' ? 'btn-primary' : ''}`}
            onClick={() => sendMessage({ type: 'chat-approval', sessionId, requestId: request.requestId, decision })}>
            {decision === 'allow' ? 'Allow' : 'Deny'}
          </button>)}</div>
      </section>)}
  </div>
}
