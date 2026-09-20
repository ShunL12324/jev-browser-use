// Only bounded categorical metadata leaves the API boundary. Never serialize
// an Error/cause, message, stack, URL, request headers or response body.
const STAGES = new Set(['fetch', 'response_json', 'validate'])
const ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'])
const CAUSE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CONNECT',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
])
export function safeApiDiagnostic(error, { stage, httpStatus, signal, callerSignal } = {}) {
  return {
    stage: STAGES.has(stage) ? stage : 'other',
    httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    aborted: signal?.aborted === true,
    callerAborted: callerSignal?.aborted === true,
    errorName: ERROR_NAMES.has(error?.name) ? error.name : 'other',
    causeCode: CAUSE_CODES.has(error?.cause?.code) ? error.cause.code : 'other'
  }
}

const QUESTION_IDS = new Set(['action', 'click_target', 'goal_met', 'blocked', 'type_target', 'type_value'])
const VALIDATION_REASONS = new Set(['type', 'missing', 'choice', 'prob_keys', 'prob_range', 'sum', 'not_argmax'])
const finite = value => Number.isFinite(value) ? value : null
export function safeValidationDiagnostic(questionId, reason, question, answer) {
  const keys = question?.criteria ? Object.keys(question.criteria) : null
  const probabilities = answer?.probabilities
  const actualKeys = probabilities ? Object.keys(probabilities) : null
  const values = probabilities ? Object.values(probabilities) : []
  const expectedValues = keys?.map(key => probabilities?.[key])
  return {
    questionId: QUESTION_IDS.has(questionId) ? questionId : 'other',
    reason: VALIDATION_REASONS.has(reason) ? reason : 'other',
    expectedKeyCount: keys?.length ?? null,
    actualKeyCount: actualKeys?.length ?? null,
    selectedInCriteria: keys ? Object.hasOwn(question.criteria, answer?.choice) : null,
    keySetMatches: keys && actualKeys ? keys.length === actualKeys.length && keys.every(key => Object.hasOwn(probabilities, key)) : null,
    sum: expectedValues?.every(Number.isFinite) ? finite(expectedValues.reduce((total, value) => total + value, 0)) : null,
    selectedProbability: finite(question?.type === 'noul' ? answer?.noul : probabilities?.[answer?.choice]),
    maxProbability: values.length && values.every(Number.isFinite) ? finite(values.reduce((max, value) => Math.max(max, value), -Infinity)) : null
  }
}
export function safeApiUsage(usage) {
  if (!Number.isFinite(usage?.input_tokens) || usage.input_tokens < 0) return undefined
  return { input_tokens: usage.input_tokens,
    ...(Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0 ? { output_tokens: usage.output_tokens } : {}) }
}
