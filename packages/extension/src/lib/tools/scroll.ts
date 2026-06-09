// Tool: scroll — four modes:
//   - target.ref: scroll that element into view in its own frame
//   - y: absolute scroll on the top frame
//   - dx/dy: relative scroll on the top frame
//   - until:'page_end': sweep to the bottom in steps so lazy-load IO callbacks fire

import { sendToFrame, sendToTop } from '../tab-message'
import { parseRef } from '../frames'
import type { ScrollParams, ScrollResult } from '../../shared/protocol'
import type { ScrollPayload } from '../../content-scripts/protocol'

/** Sweep timeout: max_steps × step_wait + headroom. Default 25 × 250ms + 5s buffer = ~12s. Caller can blow past this only with very large max_steps. */
function sweepTimeoutMs(p: ScrollParams): number {
  const max = p.max_steps ?? 25
  const wait = p.step_wait_ms ?? 250
  return max * wait + 5000
}

export async function scroll(tabId: number, params: ScrollParams): Promise<ScrollResult> {
  if (params.target?.ref) {
    const { frameId, localRef } = parseRef(params.target.ref)
    const data = await sendToFrame<ScrollPayload>(tabId, frameId, {
      op: 'scroll',
      ref: localRef
    })
    return {
      ok: true,
      scrollX: data.scrollX,
      scrollY: data.scrollY,
      scrolled: data.scrolled,
      target: data.target
    }
  }
  const isSweep = params.until === 'page_end'
  const data = await sendToTop<ScrollPayload>(tabId, {
    op: 'scroll',
    y: params.y,
    dx: params.dx,
    dy: params.dy,
    until: params.until,
    max_steps: params.max_steps,
    step_wait_ms: params.step_wait_ms
  }, isSweep ? sweepTimeoutMs(params) : undefined)
  return {
    ok: true,
    scrollX: data.scrollX,
    scrollY: data.scrollY,
    scrolled: data.scrolled,
    target: data.target,
    ...(data.steps !== undefined ? { steps: data.steps } : {}),
    ...(data.stop_reason !== undefined ? { stop_reason: data.stop_reason } : {})
  }
}
