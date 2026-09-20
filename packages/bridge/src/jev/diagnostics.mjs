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
