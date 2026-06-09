// Tool: hover — moves the pointer over an element to reveal tooltips,
// dropdown menus, and other hover-triggered UI. Pure synthetic-event
// dispatch in the content script; no CDP needed.

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import { createLogger } from '../logger'
import { snapshot } from '../snapshot'
import type { HoverParams, HoverResult } from '../../shared/protocol'
import type { HoverPayload } from '../../content-scripts/protocol'

const log = createLogger('hover')

export async function hover(tabId: number, params: HoverParams): Promise<HoverResult> {
  if (!params.target.ref) throw new Error('target.ref is required')
  const { frameId, localRef } = parseRef(params.target.ref)
  log.info(`hover tab=${tabId} frame=${frameId} ref=${localRef}`)
  const data = await sendToFrame<HoverPayload>(tabId, frameId, {
    op: 'hover',
    ref: localRef
  })
  const snap = await snapshot(tabId, {}).catch(() => null)
  return {
    ok: true,
    point: data.point,
    ...(snap ? { interactables: snap.interactables, total_interactables: snap.total_interactables } : {})
  }
}
