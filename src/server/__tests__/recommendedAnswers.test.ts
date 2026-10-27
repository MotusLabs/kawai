// recommendedAnswers (informal-question-recommendations D1): the one derivation of
// "recommended" — a deadline exists only when every question marks an option
// with an explicit recommendation in its label or description (D1).
import { describe, expect, test } from 'bun:test'
import type { ChatQuestion } from '../../shared/chat'
import { parseQuestions, recommendedAnswers } from '../chat/contentBlocks'
import { recommendationCases } from './fixtures/recommendationCases'

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


describe('informal recommendation grammar (QA-R1–QA-R5)', () => {
  for (const { option, matches } of recommendationCases) {
    test(JSON.stringify(option), () => {
      const answers = recommendedAnswers([question({ options: [option] })])
      expect(answers).toEqual(matches ? { 'Which library?': { options: [option.label] } } : null)
    })
  }

  test('mixed fields preserve input order, original labels, and one selection per option', () => {
    const options = [
      { label: 'Ignore me' },
      { label: '  A  ', description: 'I recomend this' },
      { label: 'B (Recommended)', description: 'My recommendation' },
      { label: 'C — My recommendation' },
    ]
    expect(recommendedAnswers([question({ options })])).toEqual({
      'Which library?': { options: ['  A  '] },
    })
    expect(recommendedAnswers([question({ options, multiSelect: true })])).toEqual({
      'Which library?': { options: ['  A  ', 'B (Recommended)', 'C — My recommendation'] },
    })
  })

  test('one unmarked question prevents answers even when others have description markers', () => {
    expect(recommendedAnswers([
      question({ options: [{ label: 'A', description: 'I recommend this' }] }),
      question({ question: 'Another?', options: [{ label: 'B' }] }),
    ])).toBeNull()
  })

  test('question text and non-string descriptions never supply a signal', () => {
    for (const description of [undefined, null, 42, {}, ['Recommended']]) {
      const questions = parseQuestions({ questions: [{
        question: 'I recommend this', header: 'Recommended',
        options: [{ label: 'A', description }],
      }] })!
      expect(recommendedAnswers(questions)).toBeNull()
    }
  })
})
