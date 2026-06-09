// Tool: eval_js — runs in the top frame's MAIN world (page JS context).
// The ISOLATED-world content script bridges via postMessage to the
// MAIN-world peer (see src/content-scripts/main.ts).

import { sendToTop } from '../tab-message'
import type { EvalJsParams, EvalJsResult } from '../../shared/protocol'
import type { EvalJsPayload } from '../../content-scripts/protocol'

export async function evalJs(tabId: number, params: EvalJsParams): Promise<EvalJsResult> {
  const data = await sendToTop<EvalJsPayload>(tabId, {
    op: 'eval_js',
    expression: params.expression,
    awaitPromise: !!params.awaitPromise
  })
  return { ok: true, value: data.value }
}
