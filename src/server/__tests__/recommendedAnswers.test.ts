// recommendedAnswers (question-auto-answer D1): the one derivation of
// "recommended" — a deadline exists only when every question marks an option
// whose label ends with `(Recommended)`, case-insensitively.
import { describe, expect, test } from 'bun:test'
import type { ChatQuestion } from '../../shared/chat'
import { recommendedAnswers } from '../chat/contentBlocks'

function question(overrides: Partial<ChatQuestion> = {}): ChatQuestion {
  return {
    question: 'Which library?',
    header: 'Library',
    multiSelect: false,
    options: [{ label: 'date-fns' }, { label: 'dayjs' }],
    ...overrides,
  }
}

describe('recommendedAnswers', () => {
  test('single-select takes the first marked option, label verbatim (QA-1 answers)', () => {
    const answers = recommendedAnswers([
      question({
        options: [{ label: 'A (Recommended)' }, { label: 'B (Recommended)' }, { label: 'C' }],
      }),
    ])
    expect(answers).toEqual({ 'Which library?': { options: ['A (Recommended)'] } })
  })

  test('multi-select takes every marked option in order', () => {
    const answers = recommendedAnswers([
      question({
        question: 'Pick gates?',
        multiSelect: true,
        options: [{ label: 'lint' }, { label: 'types (Recommended)' }, { label: 'tests (Recommended)' }],
      }),
    ])
    expect(answers).toEqual({ 'Pick gates?': { options: ['types (Recommended)', 'tests (Recommended)'] } })
  })

  test('an unmarked question in the request yields null (QA-9, kills M-1.2)', () => {
    expect(
      recommendedAnswers([
        question({ question: 'Marked?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }),
        question({ question: 'Unmarked?', options: [{ label: 'A' }, { label: 'B' }] }),
      ])
    ).toBeNull()
  })

  test('no marked option at all yields null', () => {
    expect(recommendedAnswers([question()])).toBeNull()
  })

  test('a question with no options yields null', () => {
    expect(recommendedAnswers([question({ options: [] })])).toBeNull()
  })

  test('the marker is case-insensitive and allows trailing whitespace', () => {
    expect(recommendedAnswers([question({ options: [{ label: '  a (RECOMMENDED)  ' }] })])).toEqual({
      'Which library?': { options: ['  a (RECOMMENDED)  '] },
    })
    expect(recommendedAnswers([question({ options: [{ label: 'a\t(recommended)\t' }] })])).toEqual({
      'Which library?': { options: ['a\t(recommended)\t'] },
    })
  })

  test('a marker mid-label does not match', () => {
    expect(recommendedAnswers([question({ options: [{ label: '(Recommended) first' }, { label: 'B' }] })])).toBeNull()
    expect(recommendedAnswers([question({ options: [{ label: 'use (Recommended) here' }] })])).toBeNull()
  })

  test('the answer array is empty-safe: an empty multi-select of matches cannot occur', () => {
    // Every match filters from the question's own options, so a null return
    // (no match) is the only way to produce no answer for a question.
    const answers = recommendedAnswers([
      question({ multiSelect: true, options: [{ label: 'only (recommended)' }] }),
    ])
    expect(answers).toEqual({ 'Which library?': { options: ['only (recommended)'] } })
  })
})
