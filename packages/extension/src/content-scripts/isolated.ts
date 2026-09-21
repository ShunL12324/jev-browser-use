import { handleS1 } from './s1'
import { documentId } from './document'
// ISOLATED-world content script — runs in every frame at document_start.
//
// Responsibilities:
//   - Receive `CSRequest` from the service worker via chrome.runtime.onMessage
//   - Dispatch to the right handler in actions.ts / snapshot.ts
//   - Reply with `CSResponse<T>`
//
// Has access to chrome.* APIs and chrome.dom.openOrClosedShadowRoot (for
// piercing closed shadow roots). Talks to MAIN-world peer via postMessage
// for things that need page-context (eval_js, dialog accept).

import type { CSRequestEnvelope, CSResponse } from './protocol'
import { buildSnapshot, whenReady } from './snapshot'
import { buildView } from './view'
import {
  actClick,
  actType,
  actHover,
  actPressKey,
  actScroll,
  actSelect,
  actWaitFor,
  actEvalJs,
  actInspect,
  actRequest,
  actSetFiles,
  flashPoint,
  flashElement
} from './actions'
import {
  installIndicators,
  showIndicators,
  hideIndicators,
  updateCursorPos
} from './indicators'

// Avoid double init on SPA route changes or repeat injection.
const FLAG = '__quarry_cs_init__'
const NET_CHANNEL = '__quarry_net__'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(window as any)[FLAG]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any)[FLAG] = true
  install()
  installNetForwarder()
  // Pre-register the indicator style/flag. Actual DOM nodes appear when the
  // SW broadcasts indicators.show (top frame only — internally guarded).
  installIndicators()
}

function install() {
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isEnvelope(msg)) return false
    handle(msg).then(
      (data) => sendResponse({ ok: true, data } as CSResponse),
      (err: unknown) => {
        // Surface `code` / `short_term` from `ActionError` (or any object that
        // happens to carry those fields) so the SW-side `sendToFrame` can
        // forward them to a `ToolFault`. Bare `Error` → defaults handled at
        // higher layers (transient).
        const message = err instanceof Error ? err.message : String(err)
        const code = (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string')
          ? (err as { code: string }).code
          : undefined
        const short_term = (err && typeof err === 'object' && 'short_term' in err && typeof (err as { short_term?: unknown }).short_term === 'boolean')
          ? (err as { short_term: boolean }).short_term
          : undefined
        sendResponse({ ok: false, message, code, short_term } as CSResponse)
      }
    )
    return true // async response
  })
}

/**
 * Forward MAIN-world network entries up to the service worker. The MAIN
 * patch posts each entry as a postMessage; ISOLATED hops it to SW via
 * chrome.runtime.sendMessage so the per-tab ring buffer can be appended.
 */
function installNetForwarder() {
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return
    const data = event.data
    if (!data || data.channel !== NET_CHANNEL || data.kind !== 'entry') return
    try {
      chrome.runtime.sendMessage({
        source: 'content',
        type: 'cs:network',
        entry: data.entry
      })
    } catch {
      /* SW may be asleep; entry lost (acceptable) */
    }
  })
}

function isEnvelope(msg: unknown): msg is CSRequestEnvelope {
  return (
    !!msg &&
    typeof msg === 'object' &&
    (msg as { __quarry?: unknown }).__quarry === true &&
    typeof (msg as { op?: unknown }).op === 'string'
  )
}

async function handle(msg: CSRequestEnvelope): Promise<unknown> {
  switch (msg.op) {
    case 's1': { await whenReady(); return handleS1(msg.request) }
    case 'snapshot': {
      await whenReady()
      return buildSnapshot({ budget: msg.budget })
    }
    case 'click':           return actClick(msg)
    case 'type':            return actType(msg)
    case 'hover':           return actHover(msg)
    case 'press_key':       return actPressKey(msg)
    case 'scroll':          return actScroll(msg)
    case 'select':          return actSelect(msg)
    case 'eval_js':         return actEvalJs(msg)
    case 'view': {
      await whenReady()
      return { ...buildView(), documentId }
    }
    case 'wait_for':        return actWaitFor(msg)
    case 'inspect':         return actInspect(msg)
    case 'request':         return actRequest(msg)
    case 'set_files':       return actSetFiles(msg)
    case 'indicators.show':   { showIndicators();           return { ok: true } }
    case 'indicators.hide':   { hideIndicators();           return { ok: true } }
    case 'indicators.cursor': { updateCursorPos(msg.x, msg.y); return { ok: true } }
    case 'indicator.flash': {
      if (typeof msg.x === 'number' && typeof msg.y === 'number') flashPoint(msg.x, msg.y)
      else if (msg.ref) flashElement(msg.ref, msg.durationMs ?? 450)
      return { ok: true }
    }
    default: {
      const _exhaustive: never = msg
      throw new Error(`unknown content-script op: ${(_exhaustive as { op: string }).op}`)
    }
  }
}

