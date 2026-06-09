// Zod schemas for all 18 browser tools. The MCP SDK uses these for input
// validation. Each schema is a raw shape — Zod expects `{ key: ZodType }`,
// not a wrapped z.object().
//
// Where the wire protocol uses a discriminated Target union ({ ref | text | point }),
// we flatten to top-level optional fields and reshape in `reshapeParams` before
// sending — MCP clients vary in how they handle nested unions.

import { z } from 'zod'

const TabIdShape = {
  tabId: z.number().int().optional().describe('Specific tab id to act on. Defaults to active tab.')
}

const TargetShape = {
  ref: z.string().optional().describe('Stable ref from a prior snapshot/view. Preferred — survives DOM mutations until the element is removed.'),
  text: z.string().optional().describe('Visible text. Fallback when no ref is available; first match wins.'),
  x: z.number().optional().describe('Viewport x coordinate. Use only when ref/text are not available.'),
  y: z.number().optional().describe('Viewport y coordinate.')
}

// ── per-tool shapes ──────────────────────────────────────────────────

export const Shapes = {
  snapshot: {
    limit: z.number().int().min(1).max(500).optional().describe('Max interactables to return. Default 50.'),
    ...TabIdShape
  },

  view: {
    image: z.boolean().optional().describe('Reserved. Image capture is currently disabled.'),
    ...TabIdShape
  },

  navigate: {
    url: z.string().describe('URL to navigate to. Absolute, including protocol.'),
    timeoutMs: z.number().int().positive().optional(),
    ...TabIdShape
  },

  click: {
    ...TargetShape,
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Default left.'),
    double: z.boolean().optional().describe('Double-click.'),
    ...TabIdShape
  },

  type: {
    ...TargetShape,
    text: z.string().describe('Text to type. UTF-8 supported.'),
    clear: z.boolean().optional().describe('Clear the field first.'),
    submit: z.boolean().optional().describe('Press Enter after typing.'),
    ...TabIdShape
  },

  press_key: {
    key: z.string().describe('Key name, e.g. "Enter", "Tab", "ArrowDown", "a".'),
    modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).optional(),
    ...TabIdShape
  },

  select: {
    ...TargetShape,
    values: z.array(z.string()).describe('Option value(s) to select. Multiple only for <select multiple>.'),
    ...TabIdShape
  },

  hover: {
    ...TargetShape,
    ...TabIdShape
  },

  upload_file: {
    ...TargetShape,
    files: z.array(z.object({
      name: z.string(),
      data: z.string().describe('base64-encoded file content'),
      mimeType: z.string().optional()
    })).describe('Files to upload to the target <input type=file>.'),
    ...TabIdShape
  },

  wait_for: {
    text: z.string().optional().describe('Wait until this text appears in the DOM.'),
    refExists: z.string().optional().describe('Wait until this ref appears.'),
    urlPattern: z.string().optional().describe('Wait until tab URL matches this regex/substring.'),
    requestPattern: z.string().optional().describe('Wait until an outgoing network request URL matches.'),
    timeoutMs: z.number().int().positive().optional(),
    ...TabIdShape
  },

  scroll: {
    dx: z.number().optional(),
    dy: z.number().optional(),
    ref: z.string().optional().describe('Scroll the nearest scrollable ancestor of this ref into view.'),
    y: z.number().optional().describe('Absolute viewport y to scroll to.'),
    until: z.literal('page_end').optional().describe('Sweep mode: scroll toward page bottom with pauses for lazy load.'),
    max_steps: z.number().int().positive().optional(),
    step_wait_ms: z.number().int().nonnegative().optional(),
    ...TabIdShape
  },

  tabs: {
    action: z.enum(['list', 'switch', 'new', 'close']).describe('Tab operation.'),
    tabId: z.number().int().optional().describe('Target tab id (for switch/close).'),
    url: z.string().optional().describe('URL for new tab.'),
    active: z.boolean().optional().describe('Ignored — new tabs always open in background.')
  },

  network_log: {
    limit: z.number().int().positive().optional(),
    sinceMs: z.number().int().nonnegative().optional().describe('Only entries newer than this timestamp.'),
    ...TabIdShape
  },

  eval_js: {
    expression: z.string().describe('JavaScript expression to evaluate in the page MAIN world.'),
    awaitPromise: z.boolean().optional().describe('If the expression returns a Promise, await it.'),
    ...TabIdShape
  },

  inspect: {
    ref: z.string().describe('Element ref from snapshot/view.'),
    fields: z.array(z.string()).describe('Field names: text, value, tag, role, name, checked, disabled, html, innerHtml, or any HTML attribute name.'),
    ...TabIdShape
  },

  get_cookie: {
    url: z.string().optional().describe('Target URL. Defaults to active tab URL.'),
    name: z.string().optional().describe('Exact cookie name filter.'),
    ...TabIdShape
  },

  request: {
    url: z.string().describe('Request URL.'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
    headers: z.record(z.string()).optional(),
    body: z.string().optional().describe('Raw string body. Mutually exclusive with json.'),
    json: z.any().optional().describe('JSON-serializable payload. Sets Content-Type to application/json.'),
    ...TabIdShape
  },

  batch: {
    actions: z.array(z.object({
      name: z.string().describe('Tool name (without browser_ prefix).'),
      input: z.any().describe('Params for that tool.')
    })).describe('Sequence of tool calls to run.'),
    stop_on_error: z.boolean().optional().describe('Stop on first error (default: true).'),
    ...TabIdShape
  }
} as const

export type ToolKey = keyof typeof Shapes

// ── reshape MCP input → wire params ───────────────────────────────────

function maybeTarget(input: Record<string, unknown>): { target: Record<string, unknown> } | Record<string, unknown> {
  const { ref, text, x, y } = input
  const t: Record<string, unknown> = {}
  if (typeof ref === 'string') t.ref = ref
  if (typeof text === 'string') t.text = text
  if (typeof x === 'number' && typeof y === 'number') t.point = { x, y }
  if (Object.keys(t).length === 0) return {}
  return { target: t }
}

/** Convert MCP-shaped input into the params shape the extension tool expects. */
export function reshapeParams(tool: ToolKey, raw: Record<string, unknown>): { params: unknown; tabId?: number } {
  const tabId = typeof raw.tabId === 'number' ? raw.tabId : undefined
  const { tabId: _drop, ...rest } = raw

  switch (tool) {
    case 'click': {
      const { ref, text, x, y, button, double } = rest as Record<string, unknown>
      void ref; void text; void x; void y
      return { tabId, params: { ...maybeTarget(rest), button, double } }
    }
    case 'type': {
      const { ref, text, x, y, ...other } = rest as Record<string, unknown>
      // 'text' here is the field being typed; the target-text is also 'text'
      // — collision. In the type tool we treat top-level `text` as the value
      // typed AND the target text (rare to want both). If user passes ref or
      // x/y, we use them for target; otherwise we leave target empty so the
      // extension falls back to the focused element. The actual typed text
      // is sent in `text`. To target by visible text, ask user to set ref
      // first via snapshot.
      void text
      const target: Record<string, unknown> = {}
      if (typeof ref === 'string') target.ref = ref
      if (typeof x === 'number' && typeof y === 'number') target.point = { x, y }
      return { tabId, params: { target, text: rest.text, clear: other.clear, submit: other.submit } }
    }
    case 'select':
    case 'hover':
    case 'upload_file': {
      const { values, files, ...targetRaw } = rest as Record<string, unknown>
      const t = maybeTarget(targetRaw)
      return { tabId, params: { ...t, values, files } }
    }
    case 'scroll': {
      const { ref, dx, dy, y, until, max_steps, step_wait_ms } = rest as Record<string, unknown>
      const params: Record<string, unknown> = { dx, dy, y, until, max_steps, step_wait_ms }
      if (typeof ref === 'string') params.target = { ref }
      return { tabId, params }
    }
    case 'tabs': {
      // Pass through but the discriminated union means we trust the action+fields combo
      return { tabId, params: rest }
    }
    default:
      // snapshot, view, navigate, press_key, wait_for, network_log,
      // eval_js, inspect, get_cookie, request, batch — params shape matches.
      return { tabId, params: rest }
  }
}

// ── tool descriptions (shown to the LLM) ─────────────────────────────

export const Descriptions: Record<ToolKey, string> = {
  snapshot: 'Capture an interactables snapshot of the active tab. Returns refs you can use with click/type/hover/etc. is_new flags appear on elements that weren\'t in the previous snapshot.',
  view: 'Reading-order markdown view of the page mixing text and [eN] refs. The canonical "see this page" tool.',
  navigate: 'Navigate the active tab to a URL. Auto-bundles a snapshot of the new page so you usually don\'t need a follow-up call.',
  click: 'Click an element. Address by ref (preferred), visible text, or x/y. Synthetic events; no CDP. Returns post-action effects (mutations, url_changed, dialog_opened).',
  type: 'Type into an input. Pass `text` for what to type. `clear:true` empties the field first; `submit:true` presses Enter after.',
  press_key: 'Press a keyboard key. Use for keys not typeable as text (Enter, Tab, ArrowDown, Escape, F5, …).',
  select: 'Pick option(s) from a <select>. Pass option `values`, not labels.',
  hover: 'Hover over an element. Useful for revealing tooltips and menu drop-downs.',
  upload_file: 'Upload base64-encoded file(s) to an <input type=file>. Provide payloads inline.',
  wait_for: 'Wait until a condition holds: text appears, ref exists, URL matches, or an outgoing request URL matches. Plain sleep if no condition is set.',
  scroll: 'Scroll the page. Relative (dx/dy), absolute (y), into-view (ref), or sweep mode (until:page_end with pauses for lazy load).',
  tabs: 'Tab management: list, switch, new, close. New tabs always open in background — call switch separately to bring forward.',
  network_log: 'Get recent network entries (fetch + XHR) for the active tab. Captured via in-page monkey-patch.',
  eval_js: 'Evaluate a JS expression in the page MAIN world. Use only for things you can\'t do via the other tools — DOM manipulation, framework state inspection, etc.',
  inspect: 'Read fields (text, value, tag, role, html, attributes, …) from an element by ref. Useful for checking state after an interaction.',
  get_cookie: 'Read cookies for a URL (defaults to active tab). Optionally filter by exact name.',
  request: 'Make an HTTP request from the page context (carries the page\'s cookies / auth). Use for API calls that need the user\'s session.',
  batch: 'Run a sequence of tool calls in one round trip. Stops on error by default, or on any tool that invalidates refs (navigate, tab switch).'
}
