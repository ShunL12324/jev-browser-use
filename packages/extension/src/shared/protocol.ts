// Tool surface shared between SW, side-panel, and (eventually) the LLM agent.
//
// Single entry point: `browser_action` with a discriminated `action` field.
// All tool params/results live here so the side panel and SW agree on shapes.

// ── Interactables / snapshot ──────────────────────────────────────────

export interface Interactable {
  ref: string
  role: string
  name: string
  tag: string
  value?: string
  disabled?: boolean
  bounds?: [number, number, number, number]
  frame_id?: string
  /** True when this snapshot is the first to surface this element to the LLM.
   *  Absent = element has been seen in a prior snapshot (ref is stable).
   *  Lets the LLM track "what's actually new on this page since last look"
   *  without scanning the whole interactables array. */
  is_new?: boolean
}

export interface SnapshotParams {
  /** Maximum number of interactables to return. Default 50; capped at 500.
   *  Raise when the page is dense (long lists, dashboards) and the default
   *  view truncates the elements you need to address. Per-frame budget is
   *  set to this same value so cross-frame coverage is consistent. */
  limit?: number
}
export interface SnapshotResult {
  ok: true
  url: string
  title: string
  interactables: Interactable[]
  /** Total interactables collected across all frames BEFORE the `limit`
   *  truncation. If this exceeds `interactables.length`, you missed some —
   *  call again with a higher `limit` or narrow with find / query. */
  total_interactables?: number
}

// ── Common Target struct ──────────────────────────────────────────────

export interface Target {
  ref?: string
  text?: string
  point?: { x: number; y: number }
}

// ── Tool params / results ─────────────────────────────────────────────

export interface NavigateParams { url: string; timeoutMs?: number }
export interface NavigateResult {
  ok: true
  url: string
  title: string
  /** Auto-bundled post-action snapshot — saves the agent a second round trip. */
  interactables?: Interactable[]
  total_interactables?: number
}

export interface ActionEffects {
  /** Total MutationObserver records = attr_mutations + added_nodes + removed_nodes.
   *  Kept for backward-compat readers; prefer the split fields below. */
  mutations: number
  /** className / style / aria-* / other attribute or characterData changes.
   *  Cheap signal — many UIs flip aria-* and class on hover/focus, so a
   *  high count alone doesn't mean the action took effect. */
  attr_mutations: number
  /** Subtree nodes added during the observation window. Strong "content
   *  actually changed" signal: tab switched, modal opened, list expanded. */
  added_nodes: number
  /** Subtree nodes removed. Pair with `added_nodes` to detect replacements. */
  removed_nodes: number
  /** Did anything change INSIDE the action's target element's subtree?
   *  `false` + `added_nodes === 0` is the strongest "click went nowhere"
   *  signal — the target itself didn't react, only ambient state shifted. */
  target_subtree_changed: boolean
  /** True if location.href changed during the observation window. */
  url_changed: boolean
  /** True if document.activeElement changed (something took focus). */
  focus_changed: boolean
  /** True if a new dialog (alert/confirm/prompt) was captured. */
  dialog_opened: boolean
}

export interface ClickParams { target: Target; button?: 'left' | 'right' | 'middle'; double?: boolean }
export interface ClickResult {
  ok: true
  point: { x: number; y: number }
  effects?: ActionEffects
  /** Auto-bundled post-action snapshot — saves the agent a second round trip. */
  interactables?: Interactable[]
  total_interactables?: number
}

export interface TypeParams { target: Target; text: string; clear?: boolean; submit?: boolean }
export interface TypeResult {
  ok: true
  typed: string
  effects?: ActionEffects
  /** Auto-bundled post-action snapshot — saves the agent a second round trip. */
  interactables?: Interactable[]
  total_interactables?: number
}

export interface ViewParams {
  /** Currently ignored — image capture is temporarily disabled (see extension/src/lib/tools/view.ts). Kept on the wire so re-enabling needs no schema churn. */
  image?: boolean
}
export interface ViewResult {
  ok: true
  url: string
  title: string
  actions: number
  texts: number
  truncated: boolean
  /** Markdown-style reading-order blob mixing text and interactive refs. */
  content: string
  /** Always absent at the moment (image capture disabled). Field kept so re-enabling is uncomment-only. */
  image?: {
    data: string
    mime: 'image/jpeg'
    bytes: number
  }
}


export interface PressKeyParams { key: string; modifiers?: Array<'alt' | 'ctrl' | 'meta' | 'shift'> }
export interface PressKeyResult { ok: true; key: string }

export interface SelectParams { target: Target; values: string[] }
export interface SelectResult {
  ok: true
  values: string[]
  /** Auto-bundled post-action snapshot — saves the agent a second round trip. */
  interactables?: Interactable[]
  total_interactables?: number
}

export interface HoverParams { target: Target }
export interface HoverResult {
  ok: true
  point: { x: number; y: number }
  /** Auto-bundled post-action snapshot — saves the agent a second round trip. */
  interactables?: Interactable[]
  total_interactables?: number
}

export interface UploadFilePayload {
  name: string
  /** base64-encoded content */
  data: string
  mimeType?: string
}
export interface UploadFileParams {
  target: Target
  /** File payloads (base64). The agent provides paths; the Electron-side
   *  tool wrapper reads them from disk and base64-encodes before sending
   *  over the bridge. */
  files: UploadFilePayload[]
}
export interface UploadFileResult { ok: true; count: number; names: string[] }

export interface WaitForParams {
  /** wait until at least one of these conditions holds */
  text?: string
  refExists?: string
  urlPattern?: string
  /** match an outgoing network request URL (uses CDP network capture) */
  requestPattern?: string
  timeoutMs?: number
}
export interface WaitForResult {
  ok: true
  /** Which condition fired:
   *   'text' / 'ref' / 'url' / 'request' — a real signal observed
   *   'timeout' — no conditions were given, this was a plain sleep
   *   (different from "we waited and none matched" — that throws a timeout
   *   error via the conditions racer when at least one condition is set) */
  matched: 'text' | 'ref' | 'url' | 'request' | 'timeout'
  elapsedMs: number
}

export interface ScrollParams {
  /** scroll by dx/dy pixels (relative; default mode) */
  dx?: number
  dy?: number
  /** scroll a specific ref into view (uses the ref's nearest scrollable ancestor, not just window) */
  target?: Target
  /** scroll to absolute viewport y */
  y?: number
  /** Sweep mode: scroll in chunks toward the end of the page, pausing between steps so IntersectionObserver-driven lazy loads can actually fire. Mutually exclusive with dx/dy/target/y. */
  until?: 'page_end'
  /** Sweep-mode safety cap on iterations. Default 25. */
  max_steps?: number
  /** Sweep-mode pause (ms) between scroll steps. Default 250 — load-bearing for IO callbacks; lower at your peril. */
  step_wait_ms?: number
}
export interface ScrollResult {
  ok: true
  /** The scrollX of whatever was actually scrolled (window or inner container). */
  scrollX: number
  /** The scrollY of whatever was actually scrolled. */
  scrollY: number
  /** True if the scroll request moved something. False = no-op (already at target / nothing scrollable found). */
  scrolled: boolean
  /** What was scrolled: 'window', a tag name (e.g. 'div') for an inner container, or 'none'. */
  target: string
  /** Sweep mode only — number of scroll steps actually executed. */
  steps?: number
  /** Sweep mode only — why the loop stopped: page_end (reached bottom), idle (2 consecutive non-scrolling steps), max_steps (safety cap). */
  stop_reason?: 'page_end' | 'idle' | 'max_steps'
}

export type TabsParams =
  | { action: 'list' }
  | { action: 'switch'; tabId: number }
  | { action: 'new'; url?: string; active?: boolean }
  | { action: 'close'; tabId: number }
export type TabsResult =
  | {
      ok: true
      action: 'list'
      active?: number
      tabs: Array<{ id: number; url: string; title: string; active: boolean }>
    }
  | { ok: true; action: 'switch'; tabId: number }
  | { ok: true; action: 'new'; tabId: number }
  | { ok: true; action: 'close'; tabId: number }

export interface NetworkLogParams { limit?: number; sinceMs?: number }
export interface NetworkLogEntry {
  ts: number
  method: string
  url: string
  status?: number
  type?: string
  durationMs?: number
}
export interface NetworkLogResult { ok: true; entries: NetworkLogEntry[] }

export interface EvalJsParams { expression: string; awaitPromise?: boolean }
export interface EvalJsResult { ok: true; value: unknown }

export interface InspectParams {
  ref: string
  /**
   * Field names to read. Built-ins: text, value, tag, role, name, checked,
   * disabled, html, innerHtml. Anything else is read as an HTML attribute.
   */
  fields: string[]
}
export interface InspectResult { ok: true; values: Record<string, string | null> }

export interface GetCookieParams {
  /** target URL; defaults to active tab URL */
  url?: string
  /** optional exact cookie name filter */
  name?: string
}
export interface CookieEntry {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}
export interface GetCookieResult { ok: true; cookies: CookieEntry[] }

export interface RequestParams {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  headers?: Record<string, string>
  /** raw string body; mutually exclusive with `json` */
  body?: string
  /** JSON-serializable payload; sets Content-Type to application/json */
  json?: unknown
}
export interface RequestResult {
  ok: true
  status: number
  /** server's ok flag (200-299) — renamed from `ok` to avoid clashing with our envelope */
  response_ok: boolean
  headers: Record<string, string>
  body: string
}

export interface BatchActionInput {
  /** Tool name (bare, as it appears on the wire). */
  name: ToolName
  /** That tool's params — same shape you'd pass when calling it directly. */
  input: unknown
}
export interface BatchParams {
  actions: BatchActionInput[]
  /** Stop the sequence on the first failed action (default: true). */
  stop_on_error?: boolean
}
export interface BatchItem {
  name: string
  ok: boolean
  /** The sub-tool's full ToolResult (success branch on ok=true, ToolError on ok=false). */
  result: unknown
}
export interface BatchResult {
  ok: true
  items: BatchItem[]
  /** Index of the action that terminated the sequence (last executed item).
   *  Set when a `terminates_sequence` tool ran, or stop_on_error fired. */
  terminated_at?: number
  /** Why the sequence ended: 'completed' (ran all), 'error' (stop_on_error),
   *  'terminates_sequence' (a tool like navigate that invalidates remaining state). */
  termination_reason: 'completed' | 'error' | 'terminates_sequence'
}

// ── Tool registry types ───────────────────────────────────────────────

export type ToolName =
  | 'snapshot'
  | 'view'
  | 'navigate'
  | 'click'
  | 'type'
  | 'press_key'
  | 'select'
  | 'hover'
  | 'upload_file'
  | 'wait_for'
  | 'scroll'
  | 'tabs'
  | 'network_log'
  | 'eval_js'
  | 'inspect'
  | 'get_cookie'
  | 'request'
  | 'batch'

export interface ToolParamsByName {
  snapshot: SnapshotParams
  view: ViewParams
  navigate: NavigateParams
  click: ClickParams
  type: TypeParams
  press_key: PressKeyParams
  select: SelectParams
  hover: HoverParams
  upload_file: UploadFileParams
  wait_for: WaitForParams
  scroll: ScrollParams
  tabs: TabsParams
  network_log: NetworkLogParams
  eval_js: EvalJsParams
  inspect: InspectParams
  get_cookie: GetCookieParams
  request: RequestParams
  batch: BatchParams
}

export interface ToolResultByName {
  snapshot: SnapshotResult
  view: ViewResult
  navigate: NavigateResult
  click: ClickResult
  type: TypeResult
  press_key: PressKeyResult
  select: SelectResult
  hover: HoverResult
  upload_file: UploadFileResult
  wait_for: WaitForResult
  scroll: ScrollResult
  tabs: TabsResult
  network_log: NetworkLogResult
  eval_js: EvalJsResult
  inspect: InspectResult
  get_cookie: GetCookieResult
  request: RequestResult
  batch: BatchResult
}

/** Tool invocation envelope. */
export interface ToolCallMessage<N extends ToolName = ToolName> {
  source: 'sidepanel' | 'popup' | 'background'
  type: 'browser_action'
  reqId?: string
  tabId?: number
  tool: N
  params: ToolParamsByName[N]
}

// ── Error model ───────────────────────────────────────────────────────
//
// All tools return `ToolResult<T>` — a discriminated union on `ok`. The
// success branches are the existing per-tool result types (`{ ok: true; ... }`).
// The failure branch carries a structured `ToolError`.
//
// `short_term` flags whether the LLM should treat the error as recoverable:
//   true  — transient. STALE_REF / NOT_FOUND / TIMEOUT / network blip. Agent
//           loop is free to drop these from conversation history on compaction.
//   false — permanent fact. Bad URL, cross-origin denied, not a <select> element.
//           Retrying with the same input won't help; the LLM has to change
//           strategy. Stays in history so the LLM doesn't repeat the mistake.
//
// Bare `throw new Error(...)` defaults to `short_term: true`. Throw a
// `ToolFault` from `extension/src/lib/tool-error.ts` to override.

export interface ToolError {
  /** Human-readable failure message. Prefixed with `[<tool>]` by executeTool. */
  message: string
  /** Stable identifier for programmatic handling, e.g. STALE_REF, TIMEOUT. */
  code?: string
  /** True (or omitted) = transient/retryable. False = permanent fact. */
  short_term?: boolean
}

export type ToolFailure = { ok: false; error: ToolError }

/** Discriminated union returned by `executeTool`. */
export type ToolResult<T extends { ok: true } = { ok: true }> = T | ToolFailure
