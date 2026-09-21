import { sendToTop } from '../tab-message'
// Single dispatch surface for all browser tools.

import { snapshot } from '../snapshot'
import { view } from './view'
import { navigate } from './navigate'
import { click } from './click'
import { typeText } from './type'
import { pressKey } from './press_key'
import { selectOption } from './select'
import { hover } from './hover'
import { uploadFile } from './upload_file'
import { waitFor } from './wait_for'
import { scroll } from './scroll'
import { tabs as tabsTool } from './tabs'
import { networkLog } from './network'
import { evalJs } from './eval_js'
import { inspect } from './inspect'
import { getCookie } from './get_cookie'
import { request } from './request'
import { batch } from './batch'
import type {
  ToolName,
  ToolParamsByName,
  ToolResult,
  ToolResultByName
} from '../../shared/protocol'
import { toToolError } from '../tool-error'

/** True when this call invalidates refs from any prior snapshot. `batch`
 *  stops the sequence after one of these to avoid forwarding stale refs. */
export function terminatesSequence(name: ToolName, params: unknown): boolean {
  if (name === 'navigate') return true
  if (name === 'tabs') {
    const action = (params as { action?: string } | null | undefined)?.action
    return action === 'switch' || action === 'new'
  }
  return false
}

/** Safety cap on batch size — protects against runaway agents and giant
 *  payloads. 50 is high enough that legitimate batches (5-10 typical) have
 *  plenty of headroom. */
export const BATCH_MAX_ITEMS = 50

/** Execute a tool and wrap any thrown error into a `ToolResult` failure
 *  branch. Bare `Error` → short_term: true; `ToolFault` → caller-controlled. */
export async function executeTool<N extends ToolName>(
  tabId: number,
  name: N,
  params: ToolParamsByName[N]
): Promise<ToolResult<ToolResultByName[N]>> {
  try {
    return await dispatch(tabId, name, params)
  } catch (e) {
    const err = toToolError(e)
    const msg = err.message.startsWith('[') ? err.message : `[${name}] ${err.message}`
    return { ok: false, error: { ...err, message: msg } }
  }
}

async function dispatch<N extends ToolName>(
  tabId: number,
  name: N,
  params: ToolParamsByName[N]
): Promise<ToolResultByName[N]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = params as any
  switch (name) {
    case 's1': return { ok: true, ...await sendToTop(tabId, { op: 's1', request: p }) as object } as ToolResultByName[N]
    case 'snapshot':         return (await snapshot(tabId, p)) as ToolResultByName[N]
    case 'view':             return (await view(tabId, p)) as ToolResultByName[N]
    case 'navigate':         return (await navigate(tabId, p)) as ToolResultByName[N]
    case 'click':            return (await click(tabId, p)) as ToolResultByName[N]
    case 'type':             return (await typeText(tabId, p)) as ToolResultByName[N]
    case 'press_key':        return (await pressKey(tabId, p)) as ToolResultByName[N]
    case 'select':           return (await selectOption(tabId, p)) as ToolResultByName[N]
    case 'hover':            return (await hover(tabId, p)) as ToolResultByName[N]
    case 'upload_file':      return (await uploadFile(tabId, p)) as ToolResultByName[N]
    case 'wait_for':         return (await waitFor(tabId, p)) as ToolResultByName[N]
    case 'scroll':           return (await scroll(tabId, p)) as ToolResultByName[N]
    case 'tabs':             return (await tabsTool(tabId, p)) as ToolResultByName[N]
    case 'network_log':      return (await networkLog(tabId, p)) as ToolResultByName[N]
    case 'eval_js':          return (await evalJs(tabId, p)) as ToolResultByName[N]
    case 'inspect':          return (await inspect(tabId, p)) as ToolResultByName[N]
    case 'get_cookie':       return (await getCookie(tabId, p)) as ToolResultByName[N]
    case 'request':          return (await request(tabId, p)) as ToolResultByName[N]
    case 'batch':            return (await batch(tabId, p)) as ToolResultByName[N]
    default: {
      const _exhaustive: never = name
      throw new Error(`unknown tool: ${_exhaustive as string}`)
    }
  }
}
