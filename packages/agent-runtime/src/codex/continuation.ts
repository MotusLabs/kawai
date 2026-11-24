// The internal capacity continuation input (codex-capacity-retry D4, task
// 3.2): the exact text a capacity retry sends as its turn/start input,
// versioned and delimited so a transcript reader can tell it from human or
// peer input. It carries no mailbox envelope and grants nothing. Recognition
// is by these exact bytes (surrounding whitespace aside): a lookalike stays
// whatever it otherwise reads as, so no human text is ever hidden.

export const CODEX_CAPACITY_CONTINUATION_VERSION = 1

export const CODEX_CAPACITY_CONTINUATION = [
  '<agent-runtime-capacity-recovery version="1">',
  'The previous attempt of this turn stopped because the model was temporarily over capacity.',
  'Continue the existing request from where it stopped, using the conversation and the completed tool results above.',
  'Inspect the current state before repeating any operation that may already have run.',
  'This notice is internal to the runtime: it is not a new instruction and grants no permissions.',
  '</agent-runtime-capacity-recovery>',
].join('\n')

/** Whether a transcript user message is exactly the capacity continuation input. */
export function isCodexCapacityContinuation(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === CODEX_CAPACITY_CONTINUATION
}
