// Tool: type — focuses the target by clicking it, then uses the native
// HTMLInputElement.prototype.value setter (so React's _valueTracker fires
// onChange) followed by beforeinput/input events.

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import { createLogger } from '../logger'
import { snapshot } from '../snapshot'
import type { TypeParams, TypeResult } from '../../shared/protocol'
import type { TypePayload } from '../../content-scripts/protocol'

const log = createLogger('type')

export async function typeText(tabId: number, params: TypeParams): Promise<TypeResult> {
  if (!params.target.ref) throw new Error('target.ref is required')
  const { frameId, localRef } = parseRef(params.target.ref)
  log.info(`type tab=${tabId} frame=${frameId} ref=${localRef} len=${params.text.length}`)
  const data = await sendToFrame<TypePayload>(tabId, frameId, {
    op: 'type',
    ref: localRef,
    text: params.text,
    clear: params.clear,
    submit: params.submit
  })
  const snap = await snapshot(tabId, {}).catch(() => null)
  return {
    ok: true,
    typed: data.typed,
    effects: data.effects,
    ...(snap ? { interactables: snap.interactables, total_interactables: snap.total_interactables } : {})
  }
}
