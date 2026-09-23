// Negative runners: prove oracles reject empty and wrong results.
//  noop   does nothing and claims success
//  wrong  claims success with a wrong answer
export function createRunner({ name = 'noop' } = {}) {
  return {
    name,
    evidence: 'negative_control',
    async run() { return { status: 'done', answer: name === 'wrong' ? 'WRONG-ANSWER 0000 Nowhere' : '', handoffs: [], metrics: { jevRequests: 0, llmRequests: 0 } } }
  }
}
