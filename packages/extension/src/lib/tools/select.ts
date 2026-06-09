// Tool: select — set the selected option(s) on a <select> element and
// dispatch input + change events so framework listeners (React, Vue)
// pick up the new value.

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import { createLogger } from '../logger'
import { snapshot } from '../snapshot'
import type { SelectParams, SelectResult } from '../../shared/protocol'
import type { SelectPayload } from '../../content-scripts/protocol'

const log = createLogger('select')

export async function selectOption(
  tabId: number,
  params: SelectParams
): Promise<SelectResult> {
  if (!params.target.ref) throw new Error('target.ref is required')
  const { frameId, localRef } = parseRef(params.target.ref)
  log.info(`select tab=${tabId} frame=${frameId} ref=${localRef} values=${params.values.join(',')}`)
  const data = await sendToFrame<SelectPayload>(tabId, frameId, {
    op: 'select',
    ref: localRef,
    values: params.values
  })
  const snap = await snapshot(tabId, {}).catch(() => null)
  return {
    ok: true,
    values: data.values,
    ...(snap ? { interactables: snap.interactables, total_interactables: snap.total_interactables } : {})
  }
}
