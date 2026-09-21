// Message protocol between the service worker and per-frame content scripts.
// This is internal — separate from the public `BridgeFrame` wire protocol
// in `src/shared/bridge.ts` that Electron talks to.
//
// Every request from SW → content script is a `CSRequest`; every reply is a
// `CSResponse<T>`. Requests are sent via `chrome.tabs.sendMessage(tabId, msg, {frameId})`
// so the SW can address a specific frame inside the tab.

import type { Interactable, ActionEffects } from '../shared/protocol'

// Re-export so content-script modules can import directly from this file
// instead of reaching across to shared/protocol.ts for a single type.
export type { ActionEffects }

export type CSRequest =
  | { op: 's1'; request: import('../shared/s1').S1Request }
  | { op: 'snapshot'; budget?: number }
  | { op: 'click'; ref: string; button?: 'left' | 'right' | 'middle'; double?: boolean }
  | { op: 'type'; ref: string; text: string; clear?: boolean; submit?: boolean }
  | { op: 'hover'; ref: string }
  | { op: 'press_key'; key: string; modifiers?: Array<'alt' | 'ctrl' | 'meta' | 'shift'> }
  | { op: 'scroll'; ref?: string; y?: number; dx?: number; dy?: number; until?: 'page_end'; max_steps?: number; step_wait_ms?: number }
  | { op: 'select'; ref: string; values: string[] }
  | { op: 'eval_js'; expression: string; awaitPromise?: boolean }
  | { op: 'view' }
  | { op: 'wait_for'; text?: string; refExists?: string; urlPattern?: string; timeoutMs?: number }
  | { op: 'indicator.flash'; ref?: string; x?: number; y?: number; durationMs?: number }
  | { op: 'inspect'; ref: string; fields: string[] }
  | { op: 'request'; url: string; method?: string; headers?: Record<string, string>; body?: string; json?: unknown }
  | { op: 'set_files'; ref: string; files: Array<{ name: string; mimeType?: string; data: string /* base64 */ }> }
  // ── Phase 5 (visual indicators) — top frame only, idempotent ──
  | { op: 'indicators.show' }
  | { op: 'indicators.hide' }
  | { op: 'indicators.cursor'; x: number; y: number }

export type CSRequestEnvelope = {
  __quarry: true
  op: CSRequest['op']
} & CSRequest

export type CSResponse<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false
      message: string
      /** Stable identifier (STALE_REF, NOT_FOUND, SELECTOR_INVALID, ...). */
      code?: string
      /** True/omitted = transient (page state-dependent). False = permanent
       *  fact (e.g. "target is not a <select> element"). */
      short_term?: boolean
    }

// ── Per-op response data shapes ────────────────────────────────────────

export interface SnapshotPayload {
  documentId: string
  coverage: { matched: number; returned: number; truncated: boolean }
  url: string
  title: string
  interactables: Interactable[]
}

export interface ClickPayload {
  point: { x: number; y: number }
  effects?: ActionEffects
}

export interface TypePayload {
  typed: string
  effects?: ActionEffects
}

export interface HoverPayload {
  point: { x: number; y: number }
}

export interface ScrollPayload {
  scrollX: number
  scrollY: number
  scrolled: boolean
  target: string
  /** Sweep mode only — steps executed. */
  steps?: number
  /** Sweep mode only — reason the loop terminated. */
  stop_reason?: 'page_end' | 'idle' | 'max_steps'
}

export interface SelectPayload {
  values: string[]
}

export interface EvalJsPayload {
  value: unknown
}

export interface InspectPayload {
  values: Record<string, string | null>
}

export interface RequestPayload {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
}

export interface SetFilesPayload {
  count: number
  names: string[]
}

export interface ViewPayload {
  documentId?: string
  url: string
  title: string
  actions: number
  texts: number
  truncated: boolean
  /** Markdown-style reading-order blob. See content-scripts/view.ts. */
  content: string
}

export interface WaitForPayload {
  matched: 'text' | 'ref' | 'url'
  elapsedMs: number
}

export interface PressKeyPayload {
  key: string
}

export interface IndicatorPayload {
  ok: true
}


