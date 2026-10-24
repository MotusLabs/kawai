// QuestionAutoAnswerSetting.tsx - the question auto-answer wait field of the
// Settings modal's Chat tab (question-auto-answer D5/D6). Unlike the modal's
// draft settings it saves to the server immediately with its own button:
// the value lives in `app_settings` and applies to every chat on the server,
// so the field loads on mount, refuses invalid input inline before any
// request, shows the server's refusal, renders 0 as off, and follows the
// change broadcast through the settings store while the input is untouched.
import { useEffect, useRef, useState } from 'react'
import { parseQuestionAutoAnswerMinutes } from '@shared/chatQuestionAutoAnswer'
import { useSettingsStore } from '../../stores/settingsStore'

const ENDPOINT = '/api/settings/question-auto-answer'

export default function QuestionAutoAnswerSetting() {
  const committed = useSettingsStore((state) => state.questionAutoAnswerMinutes)
  const setCommitted = useSettingsStore((state) => state.setQuestionAutoAnswerMinutes)
  // Null while untouched: the field shows the committed value and follows a
  // broadcast; the user's unsaved edits are never clobbered by one (#112).
  const [draft, setDraft] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    const load = async () => {
      try {
        const response = await fetch(ENDPOINT)
        if (!response.ok) return
        const body = await response.json() as { minutes?: unknown }
        setCommitted(body.minutes)
      } catch {
        // Disconnected: the last known value stays until a broadcast or a
        // later open refreshes it.
      }
    }
    void load()
    return () => { mounted.current = false }
  }, [setCommitted])

  const shown = draft ?? String(committed)

  const save = async () => {
    const parsed = parseQuestionAutoAnswerMinutes(shown.trim() === '' ? undefined : Number(shown))
    if (!parsed.valid) {
      // Refused inline, with no request and nothing stored (QA-S4).
      setRefusal(parsed.error)
      return
    }
    setSaving(true)
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: parsed.minutes }),
      })
      const body = await response.json().catch(() => ({}) as { error?: string }) as { minutes?: number; error?: string }
      if (!response.ok) {
        setRefusal(body.error ?? 'Unable to save the question auto-answer wait')
        return
      }
      if (typeof body.minutes === 'number') setCommitted(body.minutes)
      setDraft(null)
      setRefusal(null)
    } catch {
      setRefusal('Unable to save the question auto-answer wait')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-border pt-4" data-testid="question-auto-answer-setting">
      <label htmlFor="question-auto-answer-minutes" className="mb-2 block text-xs text-secondary">
        Questions
      </label>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Auto-answer wait</div>
          <div className="text-[10px] text-muted" data-testid="question-auto-answer-hint">
            {committed === 0
              ? 'Off — questions wait for you.'
              : `Fully recommended questions answer themselves after ${committed} minute${committed === 1 ? '' : 's'}.`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="question-auto-answer-minutes"
            className="input w-16 text-sm"
            type="number"
            min={0}
            step={1}
            value={shown}
            aria-label="Question auto-answer wait in minutes"
            onChange={(event) => { setDraft(event.target.value); setRefusal(null) }}
          />
          <button type="button" className="btn text-xs" disabled={saving} onClick={() => { void save() }}>
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </div>
      </div>
      {refusal && <p role="alert" className="mt-2 text-xs text-chat-danger" data-testid="question-auto-answer-refusal">{refusal}</p>}
    </div>
  )
}
