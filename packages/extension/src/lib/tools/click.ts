// Tool: click — dispatches a native pointer+mouse sequence in the page's
// content script. No CDP attach needed; coordinates and event constructors
// are sourced from the target element's own frame.

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import { createLogger } from '../logger'
import { snapshot } from '../snapshot'
import type { ClickParams, ClickResult } from '../../shared/protocol'
import type { ClickPayload } from '../../content-scripts/protocol'

const log = createLogger('click')

export async function click(tabId: number, params: ClickParams): Promise<ClickResult> {
  if (!params.target.ref) throw new Error('target.ref is required')
  const { frameId, localRef } = parseRef(params.target.ref)
  log.info(`click tab=${tabId} frame=${frameId} ref=${localRef}`)
  const data = await sendToFrame<ClickPayload>(tabId, frameId, {
    op: 'click',
    ref: localRef,
    button: params.button,
    double: params.double
  })
  const snap = await snapshot(tabId, {}).catch(() => null)
  return {
    ok: true,
    point: data.point,
    effects: data.effects,
    ...(snap ? { interactables: snap.interactables, total_interactables: snap.total_interactables } : {})
  }
}
