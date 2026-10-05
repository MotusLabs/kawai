// Interactive pending requests are authoritative server snapshots/events.
import { useState } from 'react'
import type { ChatPendingRequest, ChatQuestionAnswer } from '@shared/chat'
import type { SendClientMessage } from '@shared/types'

function QuestionForm({ request, sessionId, sendMessage, disabled }: {
  request: Extract<ChatPendingRequest, { kind: 'question' }>
  sessionId: string
  sendMessage: SendClientMessage
  disabled: boolean
}) {
  const [answers, setAnswers] = useState<Record<string, ChatQuestionAnswer>>({})
  const update = (question: string, answer: ChatQuestionAnswer) => setAnswers(current => ({ ...current, [question]: answer }))
  return <form className="space-y-3 border border-border bg-elevated p-4" onSubmit={event => {
    event.preventDefault()
    sendMessage({ type: 'chat-answer', sessionId, requestId: request.requestId, answers })
  }}>
    {request.questions.map(question => {
      const answer = answers[question.question] ?? {}
      return <fieldset key={question.question} disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">{question.question}</legend>
        <div className="space-y-2">
          {question.options.map(option => <label key={option.label} className="flex items-start gap-2 text-sm">
            <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${request.requestId}-${question.header}`}
              checked={answer.options?.includes(option.label) ?? false}
              onChange={event => update(question.question, {
                ...answer,
                options: question.multiSelect
                  ? event.target.checked ? [...(answer.options ?? []), option.label] : (answer.options ?? []).filter(value => value !== option.label)
                  : [option.label],
              })} />
            <span>{option.label}{option.description && <span className="block text-xs text-secondary">{option.description}</span>}</span>
          </label>)}
          <input className="input" aria-label={`Free-text answer: ${question.question}`} placeholder="Your answer"
            value={answer.text ?? ''} onChange={event => update(question.question, { ...answer, text: event.target.value })} />
        </div>
      </fieldset>
    })}
    <button className="btn btn-primary" disabled={disabled || request.questions.some(question => {
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
        <h3 className="text-sm font-medium">Approve {request.tool}?</h3>
        <p className="mt-1 truncate text-xs text-secondary">{JSON.stringify(request.input)}</p>
        <details className="my-3 text-xs"><summary>Arguments</summary>
          <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(request.input, null, 2)}</pre>
        </details>
        <div className="flex gap-2">{(['allow', 'deny'] as const).map(decision =>
          <button key={decision} disabled={disabled} className={`btn ${decision === 'allow' ? 'btn-primary' : ''}`}
            onClick={() => sendMessage({ type: 'chat-approval', sessionId, requestId: request.requestId, decision })}>
            {decision === 'allow' ? 'Allow' : 'Deny'}
          </button>)}</div>
      </section>)}
  </div>
}
